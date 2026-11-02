"""Download official SDK assets only; validate ONNX hashes before installation."""
from pathlib import Path
import hashlib
import json
import shutil
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / 'rehab-data/models'
CANDIDATES = (
    ('rtmpose-m-wholebody-official',
     'https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-ucoco_dw-ucoco_270e-256x192-c8b76419_20230728.zip',
     '20230831/rtmpose_onnx/rtmpose-m_simcc-ucoco_dw-ucoco_270e-256x192-c8b76419_20230728',
     '94ca58fa2d6c4530b6957ac9548084ebc2fa27ed71e4e01f0b73844306ed01a6'),
    ('official-detector',
     'https://download.openmmlab.com/mmpose/v1/projects/rtmpose/rtmpose-cpu.zip',
     'rtmpose-ort/rtmdet-nano',
     'b8585adb6d1352796f6e86337e09c3459b830645a7e7192d9381670bea2facbd'),
)


def setup():
    MODELS.mkdir(parents=True, exist_ok=True)
    for name, url, member, expected in CANDIDATES:
        destination = MODELS / name / member
        model = destination / 'end2end.onnx'
        if model.exists():
            if hashlib.sha256(model.read_bytes()).hexdigest() != expected:
                raise RuntimeError(f'Existing {model} checksum mismatch; refusing overwrite')
        else:
            archive = MODELS / (name + '-setup.zip')
            if not archive.exists():
                partial = archive.with_suffix('.part')
                with urllib.request.urlopen(url, timeout=60) as source, partial.open('xb') as target:
                    shutil.copyfileobj(source, target)
                partial.rename(archive)
            with zipfile.ZipFile(archive) as sdk:
                data = sdk.read(member + '/end2end.onnx')
                if hashlib.sha256(data).hexdigest() != expected:
                    raise RuntimeError(f'{name}: official ONNX hash mismatch')
                destination.mkdir(parents=True, exist_ok=True)
                # Explicit filenames, never extract arbitrary archive paths or executables.
                for filename in ('end2end.onnx', 'pipeline.json', 'deploy.json', 'detail.json'):
                    path = destination / filename
                    with path.open('xb') as target:
                        target.write(data if filename == 'end2end.onnx' else sdk.read(member + '/' + filename))
        provenance = MODELS / name / 'setup-provenance.json'
        if not provenance.exists():
            provenance.write_text(json.dumps({'official_url': url, 'onnx_sha256': expected,
                'code_license': 'Apache-2.0: https://github.com/open-mmlab/mmpose/blob/main/LICENSE',
                'weights_note': 'Official SDK; no separate checkpoint license bundled. Preserve training-data/license limitations; do not redistribute without checking terms.'}, indent=2), encoding='utf-8')
        web = ROOT / 'frontend/public/rtmpose' / ('medium.onnx' if name == 'rtmpose-m-wholebody-official' else 'detector.onnx')
        web.parent.mkdir(parents=True, exist_ok=True)
        if not web.exists():
            shutil.copyfile(model, web)
        elif hashlib.sha256(web.read_bytes()).hexdigest() != expected:
            raise RuntimeError(f'Browser model {web} checksum mismatch; refusing overwrite')
        print(f'Verified {name}: {expected}')


if __name__ == '__main__':
    setup()
