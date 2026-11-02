"""Official SDK RTMDet-nano person graph; lazy, explicit GPU compilation."""
from pathlib import Path
from time import perf_counter
import hashlib
import numpy as np
import openvino as ov
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / 'rehab-data/models/official-detector/rtmpose-ort/rtmdet-nano/end2end.onnx'
SHA256 = 'b8585adb6d1352796f6e86337e09c3459b830645a7e7192d9381670bea2facbd'
METADATA = {'model': 'rtmdet_nano_8xb32-300e_coco-person_in1kpretrain-96154d0b',
            'sha256': SHA256, 'source': 'https://download.openmmlab.com/mmpose/v1/projects/rtmpose/rtmpose-cpu.zip',
            'runtime': 'OpenVINO GPU', 'inputWidth': 320, 'inputHeight': 320,
            'selection': 'exactly one person with score >=0.5; ambiguity rejected'}
compiled = None


def detect_person(image: Image.Image) -> dict:
    global compiled
    started = perf_counter()
    initialization_ms = 0
    if compiled is None:
        if hashlib.sha256(MODEL.read_bytes()).hexdigest() != SHA256:
            raise RuntimeError('Official detector checksum mismatch')
        core = ov.Core()
        graph = core.read_model(MODEL)
        graph.reshape({graph.input(0): [1, 3, 320, 320]})
        candidate = core.compile_model(graph, 'GPU', {'PERFORMANCE_HINT': 'LATENCY',
            'INFERENCE_PRECISION_HINT': 'f16', 'CACHE_DIR': str(ROOT / 'rehab-data/models/openvino-cache')})
        devices = candidate.get_property('EXECUTION_DEVICES')
        if not devices or any(not str(device).startswith('GPU') for device in devices):
            raise RuntimeError('Person detector requires GPU; CPU fallback prohibited')
        compiled = candidate
        initialization_ms = (perf_counter() - started) * 1000
    preprocess_started = perf_counter()
    width, height = image.size
    scale = min(320 / width, 320 / height)
    resized_width, resized_height = int(width * scale + .5), int(height * scale + .5)
    padded = Image.new('RGB', (320, 320), (114, 114, 114))
    padded.paste(image.resize((resized_width, resized_height), Image.Resampling.BILINEAR), (0, 0))
    bgr = np.asarray(padded, dtype=np.float32)[..., ::-1]
    tensor = ((bgr - np.array([103.53, 116.28, 123.675], np.float32)) /
              np.array([57.375, 57.12, 58.395], np.float32)).transpose(2, 0, 1)[None]
    inference_started = perf_counter()
    output = compiled([np.ascontiguousarray(tensor)])
    inference_ended = perf_counter()
    dets = output[compiled.output('dets')][0]
    labels = output[compiled.output('labels')][0]
    people = []
    for bbox, label in zip(dets, labels):
        if label != 0 or not np.isfinite(bbox).all() or bbox[4] < .5:
            continue
        x1, y1, x2, y2 = bbox[:4] / np.array([resized_width, resized_height, resized_width, resized_height])
        x1, y1, x2, y2 = [float(np.clip(value, 0, 1)) for value in (x1, y1, x2, y2)]
        if x2 > x1 and y2 > y1:
            people.append({'x': x1, 'y': y1, 'width': x2 - x1, 'height': y2 - y1, 'score': float(bbox[4])})
    ended = perf_counter()
    return {'roi': people[0] if len(people) == 1 else None, 'people': people,
            'valid': len(people) == 1, 'reason': None if len(people) == 1 else 'no_person' if not people else 'multiple_people',
            'metadata': {**METADATA, 'executionDevices': compiled.get_property('EXECUTION_DEVICES'), 'gpuVerified': True},
            'timestamps': {'inferenceStarted': inference_started * 1000, 'inferenceCompleted': inference_ended * 1000},
            'timings': {'detectionInitializationMs': initialization_ms,
                        'detectionPreprocessMs': (inference_started - preprocess_started) * 1000,
                        'detectionInferenceMs': (inference_ended - inference_started) * 1000,
                        'detectionPostprocessMs': (ended - inference_ended) * 1000,
                        'detectionTotalMs': (ended - started) * 1000}}
