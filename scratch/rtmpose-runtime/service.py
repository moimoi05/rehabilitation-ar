"""Experimental RTMPose service. Localhost only; explicit Intel GPU, no CPU fallback."""
from __future__ import annotations
import hashlib
import io
import json
import math
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from time import perf_counter
from urllib.parse import urlsplit
import numpy as np
import openvino as ov
from PIL import Image, UnidentifiedImageError
from person_detector import detect_person, METADATA as DETECTOR_METADATA

ROOT = Path(__file__).resolve().parents[2]
MODEL = next((ROOT / 'rehab-data/models/rtmpose-m-wholebody-official').rglob('end2end.onnx'))
MODEL_NAME = 'rtmpose-m_simcc-ucoco_dw-ucoco_270e-256x192-c8b76419_20230728'
MODEL_SHA256 = '94ca58fa2d6c4530b6957ac9548084ebc2fa27ed71e4e01f0b73844306ed01a6'
WIDTH, HEIGHT = 192, 256
MAX_BYTES = 4 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 4096 * 4096
LOCK = Lock()
CORE = ov.Core()
if hashlib.sha256(MODEL.read_bytes()).hexdigest() != MODEL_SHA256:
    raise RuntimeError('Official local ONNX checksum mismatch')
GRAPH = CORE.read_model(MODEL)
GRAPH.reshape({GRAPH.input(0): [1, 3, HEIGHT, WIDTH]})
COMPILED = CORE.compile_model(GRAPH, 'GPU', {'PERFORMANCE_HINT': 'LATENCY', 'INFERENCE_PRECISION_HINT': 'f16', 'CACHE_DIR': str(ROOT / 'rehab-data/models/openvino-cache')})
DEVICES = COMPILED.get_property('EXECUTION_DEVICES')
if not DEVICES or any(not str(device).startswith('GPU') for device in DEVICES):
    raise RuntimeError(f'GPU required, actual execution devices: {DEVICES}')
# Validate real GPU execution before publishing a ready endpoint.
PROBE = COMPILED([np.zeros((1, 3, HEIGHT, WIDTH), np.float32)])
if not all(np.isfinite(value).all() for value in PROBE.values()):
    raise RuntimeError('GPU graph produced non-finite outputs')
INFO = {'serviceVersion': 'rtmpose-gpu-v2', 'servicePath': str(Path(__file__).resolve()), 'engine': 'rtmpose', 'runtime': 'OpenVINO GPU', 'runtimeVersion': ov.__version__,
        'model': MODEL_NAME, 'modelVersion': '20230728 official distilled medium',
        'modelSha256': MODEL_SHA256, 'device': CORE.get_property('GPU', 'FULL_DEVICE_NAME'),
        'executionDevices': DEVICES, 'gpuVerified': True, 'cpuFallback': False,
        'inputWidth': WIDTH, 'inputHeight': HEIGHT, 'coordinateSystem': 'model-input-pixels',
        'semantics': '2d-only; SimCC confidence is not MediaPipe visibility',
        'detector': None, 'detectorAvailable': DETECTOR_METADATA, 'roiStrategy': 'operator-confirmed single-person ROI; padding1.25',
        'roiLimitations': 'Boundary/confidence checks cannot guarantee hidden limbs or identity remain within ROI.'}


def parse_roi(raw: str | None) -> tuple[float, float, float, float]:
    value = json.loads(raw or 'null')
    if isinstance(value, dict) and set(value) == {'x', 'y', 'width', 'height'}:
        value = [value['x'], value['y'], value['width'], value['height']]
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError('X-Person-ROI must be normalized [x,y,width,height]')
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in value):
        raise ValueError('ROI coordinates must be finite numbers')
    x, y, width, height = value
    if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1 or y + height > 1:
        raise ValueError('ROI must be a nonempty rectangle inside source image')
    return x, y, width, height


def detect(payload: bytes, roi: tuple[float, float, float, float], use_detector: bool = False) -> dict:
    started = perf_counter()
    with Image.open(io.BytesIO(payload)) as original:
        if original.format != 'JPEG':
            raise ValueError('JPEG body required')
        image_width, image_height = original.size
        if not (32 <= image_width <= 4096 and 32 <= image_height <= 4096):
            raise ValueError('Source image dimensions must be 32..4096 pixels')
        image = original.convert('RGB')
    validation_roi = roi
    decode_ended = perf_counter()
    detector = detect_person(image) if use_detector else None
    if detector:
        if not detector['valid']:
            return {'keypoints': [{'x': None, 'y': None, 'score': None} for _ in range(133)],
                    'inputWidth': WIDTH, 'inputHeight': HEIGHT, 'imageWidth': image_width, 'imageHeight': image_height,
                    'crop': {'x': 0, 'y': 0, 'width': image_width, 'height': image_height},
                    'roi': list(roi), 'roiValid': False, 'roiReason': detector['reason'],
                    'boundaryKeypoints': [], 'runtime': INFO, 'detector': detector,
                    'timings': {**detector['timings'], 'preprocessMs': (perf_counter() - started) * 1000,
                                'inferenceMs': 0, 'postprocessMs': 0, 'totalMs': (perf_counter() - started) * 1000}}
        person = detector['roi']
        roi = (person['x'], person['y'], person['width'], person['height'])
    pose_preprocess_started = perf_counter()
    x, y, width, height = roi
    box_width, box_height = width * image_width, height * image_height
    crop_width = max(box_width, box_height * WIDTH / HEIGHT) * 1.25
    crop_height = crop_width * HEIGHT / WIDTH
    left = (x + width / 2) * image_width - crop_width / 2
    top = (y + height / 2) * image_height - crop_height / 2
    crop = {'x': left, 'y': top, 'width': crop_width, 'height': crop_height}
    transformed = image.transform((WIDTH, HEIGHT), Image.Transform.AFFINE,
        (crop_width / WIDTH, 0, left, 0, crop_height / HEIGHT, top),
        resample=Image.Resampling.BILINEAR, fillcolor=(0, 0, 0))
    pixels = np.asarray(transformed, dtype=np.float32)
    tensor = ((pixels - np.array([123.675, 116.28, 103.53], np.float32)) /
              np.array([58.395, 57.12, 57.375], np.float32)).transpose(2, 0, 1)[None]
    inference_start = perf_counter()
    output = COMPILED([np.ascontiguousarray(tensor)])
    inference_end = perf_counter()
    sx, sy = output[COMPILED.output('simcc_x')][0], output[COMPILED.output('simcc_y')][0]
    if sx.shape != (133, WIDTH * 2) or sy.shape != (133, HEIGHT * 2):
        raise RuntimeError('Unexpected WholeBody SimCC output shape')
    scores = np.minimum(sx.max(axis=1), sy.max(axis=1))
    coords = np.stack((sx.argmax(axis=1), sy.argmax(axis=1)), axis=1).astype(float) / 2
    keypoints = [{'x': float(p[0]), 'y': float(p[1]), 'score': float(score)}
                 if np.isfinite(score) and np.isfinite(p).all() and score > 0
                 else {'x': None, 'y': None, 'score': float(score) if np.isfinite(score) else None}
                 for p, score in zip(coords, scores)]
    validation_x, validation_y, validation_width, validation_height = validation_roi if detector else roi
    relevant = [5, 6, 7, 8, 9, 10, *range(91, 133)]
    boundary = []
    for index in relevant:
        point = keypoints[index]
        if point['score'] is None or point['score'] < .3:
            continue
        nx = (left + point['x'] / WIDTH * crop_width) / image_width
        ny = (top + point['y'] / HEIGHT * crop_height) / image_height
        if nx <= validation_x + validation_width * .02 or nx >= validation_x + validation_width * .98 or ny <= validation_y + validation_height * .02 or ny >= validation_y + validation_height * .98:
            boundary.append(index)
    torso_available = all(keypoints[index]['score'] is not None and keypoints[index]['score'] >= .3 for index in [5, 6])
    ended = perf_counter()
    return {'keypoints': keypoints, 'inputWidth': WIDTH, 'inputHeight': HEIGHT,
            'imageWidth': image_width, 'imageHeight': image_height, 'crop': crop,
            'roi': list(roi), 'validationRoi': list(validation_roi), 'roiValid': not boundary and torso_available,
            'roiReason': 'boundary_or_missing_shoulders' if boundary or not torso_available else None,
            'boundaryKeypoints': boundary, 'runtime': INFO, 'detector': detector,
            'stageTimestamps': {'requestStarted': started * 1000, 'inferenceStarted': inference_start * 1000, 'inferenceCompleted': inference_end * 1000, 'postprocessCompleted': ended * 1000},
            'timings': {**(detector['timings'] if detector else {}), 'frameDecodeMs': (decode_ended - started) * 1000, 'preprocessMs': (inference_start - pose_preprocess_started) * 1000,
                        'inferenceMs': (inference_end - inference_start) * 1000,
                        'postprocessMs': (ended - inference_end) * 1000,
                        'totalMs': (ended - started) * 1000}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def allowed(self) -> bool:
        origin = self.headers.get('Origin')
        host = self.headers.get('Host', '')
        if self.client_address[0] not in ('127.0.0.1', '::1') or host not in ('127.0.0.1:8766', 'localhost:8766'):
            return False
        if origin is None:
            return True
        return origin in {f'http://{name}:{port}' for name in ('localhost', '127.0.0.1') for port in (5173, 5174, 5175)}

    def reply(self, status: int, body: dict) -> None:
        data = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        origin = self.headers.get('Origin')
        if origin and self.allowed():
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def do_OPTIONS(self) -> None:
        if not self.allowed():
            self.reply(403, {'error': 'Loopback host/origin required'}); return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', 'http://127.0.0.1:5173'))
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Person-ROI, X-ROI-Confirmed, X-Person-Detection')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self) -> None:
        if not self.allowed():
            self.reply(403, {'error': 'Loopback host/origin required'}); return
        if self.path == '/drain':
            if not LOCK.acquire(timeout=15):
                self.reply(503, {'error': 'Inference still busy; switching engines must wait'}); return
            LOCK.release()
            self.reply(200, {'idle': True}); return
        if self.path != '/info':
            self.reply(404, {'error': 'Not found'}); return
        self.reply(200, INFO)

    def do_POST(self) -> None:
        if not self.allowed():
            self.reply(403, {'error': 'Loopback host/origin required'}); return
        if self.path != '/detect':
            self.reply(404, {'error': 'Not found'}); return
        try:
            use_detector = self.headers.get('X-Person-Detection') == 'true'
            if not use_detector and self.headers.get('X-ROI-Confirmed') != 'true':
                raise ValueError('Operator-confirmed ROI required')
            if self.headers.get('Content-Type', '').split(';')[0] != 'image/jpeg':
                raise ValueError('Content-Type image/jpeg required')
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > MAX_BYTES:
                self.reply(413, {'error': 'JPEG must be 1 byte..4 MiB'}); return
            roi = parse_roi(self.headers.get('X-Person-ROI'))
            if not LOCK.acquire(blocking=False):
                self.reply(429, {'error': 'Inference busy; keep only one frame in flight'}); return
            try:
                self.connection.settimeout(10)
                payload = self.rfile.read(length)
                if len(payload) != length:
                    raise ValueError('Truncated JPEG body')
                result = detect(payload, roi, use_detector)
            finally:
                LOCK.release()
            self.reply(200, result)
        except (ValueError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
            self.reply(422, {'error': str(exc)})
        except Exception as exc:
            print(f'RTMPose inference error: {type(exc).__name__}: {exc}', flush=True)
            self.reply(500, {'error': 'RTMPose GPU inference failed; see local service log'})


class LocalInferenceServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR can otherwise route requests to an older process.
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


if __name__ == '__main__':
    print(json.dumps(INFO), flush=True)
    print('Listening only on http://127.0.0.1:8766', flush=True)
    LocalInferenceServer(('127.0.0.1', 8766), Handler).serve_forever()
