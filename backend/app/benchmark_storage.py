"""Local benchmark artifacts, deliberately independent of clinical capture/DB."""
import csv
import json
import os
import platform
import shutil
import subprocess
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
SOURCE = REPOSITORY / 'video_test' / 'WIN_20261101_00_59_17_Pro.mp4'
REQUIRED = ('annotated.mp4', 'landmarks.jsonl', 'fps.csv', 'summary.json', 'report.md', 'manifest.json')
FPS_COLUMNS = ('timestamp_ms', 'source_fps', 'pose_fps', 'hand_fps', 'render_fps',
               'pose_latency_ms', 'hand_latency_ms', 'pose_result_age_ms', 'hand_result_age_ms',
               'skipped_frames', 'pose_tracking_valid', 'hand_tracking_valid')


def root():
    return Path(os.getenv('REHAB_BENCHMARK_DIR', str(REPOSITORY / 'rehab-data' / 'benchmarks'))).resolve()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')


def executable(name):
    configured = os.getenv('BENCHMARK_' + name.upper()) or shutil.which(name)
    if configured:
        return configured
    local = sorted((REPOSITORY / 'rehab-data' / 'tools').glob(f'**/{name}.exe'))
    if local:
        return str(local[-1])
    raise RuntimeError(f'{name} unavailable; set BENCHMARK_{name.upper()} to a local executable')


def probe(path):
    result = subprocess.run([executable('ffprobe'), '-v', 'error', '-select_streams', 'v:0',
                             '-show_streams', '-show_format', '-of', 'json', str(path)],
                            capture_output=True, text=True, timeout=30, check=True)
    value = json.loads(result.stdout)
    stream = value['streams'][0]
    fraction = stream.get('avg_frame_rate', '0/0').split('/')
    fps = float(fraction[0]) / float(fraction[1]) if len(fraction) == 2 and float(fraction[1]) else None
    return {'width': stream['width'], 'height': stream['height'],
            'duration': float(value['format'].get('duration', stream.get('duration', 0))),
            'fps': fps, 'r_frame_rate': stream.get('r_frame_rate'),
            'avg_frame_rate': stream.get('avg_frame_rate'), 'nb_frames': stream.get('nb_frames'),
            'codec': stream.get('codec_name'), 'size_bytes': path.stat().st_size}


@lru_cache(maxsize=1)
def hardware():
    base = {'operating_system': platform.platform(), 'cpu': platform.processor(), 'gpu': None, 'ram_bytes': None}
    if os.name != 'nt':
        return base
    script = "[ordered]@{cpu=(Get-CimInstance Win32_Processor).Name;gpu=@((Get-CimInstance Win32_VideoController).Name);ram_bytes=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory;operating_system=(Get-CimInstance Win32_OperatingSystem).Caption} | ConvertTo-Json -Compress"
    try:
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                                capture_output=True, text=True, timeout=20, check=True)
        return {**base, **json.loads(result.stdout)}
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        return {**base, 'measurement_error': str(exc)}


def source_info():
    # Opening first preserves the exact filesystem error for the requested source.
    with SOURCE.open('rb'):
        pass
    value = {'source_path': str(SOURCE), 'size_bytes': SOURCE.stat().st_size, 'hardware': hardware()}
    try:
        return {**value, **probe(SOURCE)}
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, RuntimeError) as exc:
        return {**value, 'probe_error': str(exc)}


def convert_recording(folder):
    output = folder / 'annotated.mp4'
    if output.exists():
        return
    source = next((folder / name for name in ('annotated.webm', 'recording.webm') if (folder / name).exists()), None)
    if source is None:
        raise ValueError('No annotated recording was uploaded')
    temporary = folder / 'annotated.partial.mp4'
    result = subprocess.run([executable('ffmpeg'), '-nostdin', '-v', 'error', '-n', '-i', str(source),
                             '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                             '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(temporary)],
                            capture_output=True, text=True, timeout=600)
    (folder / 'transcode.log').write_text(result.stderr or 'Local H.264 conversion succeeded.\n', encoding='utf-8')
    if result.returncode:
        raise ValueError('ffmpeg conversion failed: ' + result.stderr[-2000:])
    temporary.rename(output)


def verify_data(folder):
    observations = 0
    required = {'run_id', 'frame_id', 'source_timestamp_ms', 'raw_pose_landmarks', 'raw_hand_landmarks'}
    with (folder / 'landmarks.jsonl').open(encoding='utf-8') as handle:
        for line in handle:
            value = json.loads(line)
            if not required.issubset(value) or value['run_id'] != folder.name:
                raise ValueError('Invalid landmark observation schema/run ID')
            observations += 1
    if not observations:
        raise ValueError('No actual landmark observations')
    with (folder / 'fps.csv').open(encoding='utf-8', newline='') as handle:
        rows = csv.DictReader(handle)
        if not set(FPS_COLUMNS).issubset(rows.fieldnames or []):
            raise ValueError('FPS CSV is missing required columns')
        if not any(rows):
            raise ValueError('FPS CSV contains no measurements')
    return observations


def report(summary, config, errors):
    # Keep all measured fields visible even if a newer frontend adds metric names.
    return '\n'.join([
        '# Báo cáo benchmark MediaPipe', '',
        f"- Run: {summary['run_id']}", f"- Trạng thái: {summary['artifact_status']}",
        '- Cấu hình kiểm thử: video cục bộ, không liên kết bệnh nhân hoặc điểm lâm sàng.',
        '- Delegate thực tế, hiệu năng Pose/Hand và render: xem số đo JSON bên dưới.',
        '- CPU/GPU: thông tin thiết bị được đọc tại máy; chưa đo phần trăm sử dụng hoặc nhiệt độ.',
        '- So với CPU baseline: đối chiếu các run cùng lịch inference, độ phân giải và warm-up; một run riêng không chứng minh cải thiện.',
        '- Chất lượng: xem annotated.mp4 và raw/filtered trong landmarks.jsonl; tỷ lệ phát hiện không thay thế đánh giá độ chính xác.',
        '- Nút thắt: chỉ kết luận từ latency, FPS và frame skip thực đo; chưa kết luận thermal throttling.',
        '- Cấu hình production: chọn sau khi so sánh các lần chạy lặp; không tự giảm chất lượng model.',
        '- Giới hạn: Canvas/MediaRecorder và ghi artifact có chi phí; không có ground truth lâm sàng.', '',
        '## Cấu hình', '```json', json.dumps(config, ensure_ascii=False, indent=2), '```', '',
        '## Số đo thực tế', '```json', json.dumps(summary, ensure_ascii=False, indent=2), '```', '',
        '## Lỗi', *(errors or ['Không ghi nhận lỗi tạo artifact.']), '',
    ])


def finalize(folder, error=None):
    config = json.loads((folder / 'configuration.json').read_text(encoding='utf-8'))
    errors = [error] if error else []
    try:
        summary = json.loads((folder / 'summary.json').read_text(encoding='utf-8'))
        if not isinstance(summary, dict):
            raise ValueError('summary.json must be an object')
    except (OSError, ValueError) as exc:
        summary = {}
        errors.append(str(exc))
    summary = {**summary, 'run_id': folder.name, 'source_video_path': str(SOURCE),
               'hardware': hardware(), 'finalized_at': datetime.now(timezone.utc).isoformat()}
    if not error:
        try:
            convert_recording(folder)
            summary['annotated_video_metadata'] = probe(folder / 'annotated.mp4')
            # Decode the entire output, not just its container header.
            check = subprocess.run([executable('ffmpeg'), '-nostdin', '-v', 'error', '-i',
                                    str(folder / 'annotated.mp4'), '-f', 'null', '-'],
                                   capture_output=True, text=True, timeout=600)
            if check.returncode or check.stderr.strip():
                raise ValueError('MP4 decode verification: ' + check.stderr[-2000:])
            summary['verified_observations'] = verify_data(folder)
        except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as exc:
            errors.append(str(exc))
    for name in ('annotated.mp4', 'landmarks.jsonl', 'fps.csv'):
        if not (folder / name).is_file() or not (folder / name).stat().st_size:
            errors.append(f'Missing or empty artifact: {name}')
    status = 'INCOMPLETE' if errors else 'COMPLETE'
    summary = {**summary, 'artifact_status': status, 'artifact_errors': errors}
    write_json(folder / 'summary.json', summary)
    (folder / 'report.md').write_text(report(summary, config, errors), encoding='utf-8')
    manifest = {'run_id': folder.name, 'status': status, 'configuration': config, 'errors': errors,
                'artifacts': [{'name': p.name, 'size_bytes': p.stat().st_size,
                               'status': 'generated'} for p in sorted(folder.iterdir()) if p.is_file() and p.name != '.busy']}
    manifest['artifacts'].append({'name': 'manifest.json', 'size_bytes': 0, 'status': 'generated'})
    # Self-size converges after its digit count stabilizes.
    for _ in range(4):
        write_json(folder / 'manifest.json', manifest)
        manifest['artifacts'][-1]['size_bytes'] = (folder / 'manifest.json').stat().st_size
    return {'run_id': folder.name, 'status': status, 'directory': str(folder), 'errors': errors, 'summary': summary}
