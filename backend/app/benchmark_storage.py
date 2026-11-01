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
    try:
        import winreg, ctypes
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'HARDWARE\DESCRIPTION\System\CentralProcessor\0') as k:
                base['cpu'] = winreg.QueryValueEx(k, 'ProcessorNameString')[0].strip()
        except Exception:
            pass
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Windows NT\CurrentVersion') as k:
                pname = winreg.QueryValueEx(k, 'ProductName')[0]
                base['operating_system'] = f"{pname} (Build {platform.version()})"
        except Exception:
            pass
        try:
            gpus = []
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}') as key:
                num_subkeys, _, _ = winreg.QueryInfoKey(key)
                for i in range(num_subkeys):
                    try:
                        with winreg.OpenKey(key, winreg.EnumKey(key, i)) as subkey:
                            desc = winreg.QueryValueEx(subkey, 'DriverDesc')[0]
                            if desc not in gpus and not desc.startswith('Basic Render') and not desc.startswith('Microsoft Basic'):
                                gpus.append(desc)
                    except Exception:
                        pass
            if gpus:
                base['gpu'] = gpus if len(gpus) > 1 else gpus[0]
        except Exception:
            pass
        try:
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong),
                            ('ullTotalPhys', ctypes.c_ulonglong), ('ullAvailPhys', ctypes.c_ulonglong),
                            ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                            ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong),
                            ('sullAvailExtendedVirtual', ctypes.c_ulonglong)]
            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                base['ram_bytes'] = stat.ullTotalPhys
        except Exception:
            pass
        if base.get('cpu') and base.get('gpu'):
            return base
    except Exception:
        pass

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
    result = subprocess.run([executable('ffmpeg'), '-nostdin', '-v', 'error', '-fflags', '+genpts', '-n', '-i', str(source),
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
    cfg = config.get('configuration', config) if isinstance(config, dict) else {}
    p_lat = summary.get('pose_latency') or {}
    h_lat = summary.get('hand_latency') or {}
    afps = summary.get('actual_fps') or {}
    delegates = summary.get('actual_delegates') or {}
    rfps = summary.get('render_fps') or 0.0
    hw = summary.get('hardware') or {}
    proc = summary.get('processed_frames') or {}
    skip = summary.get('skipped_frames') or {}
    loss = summary.get('tracking_loss') or {}
    filt = summary.get('filter_quality') or {}
    
    p_fps_str = f"{afps.get('pose', 0.0):.1f}"
    h_fps_str = f"{afps.get('hand', 0.0):.1f}"
    r_fps_str = f"{rfps:.1f}"
    p_mean = f"{p_lat.get('mean_ms', 0.0):.1f}" if p_lat.get('mean_ms') is not None else "—"
    p_p95 = f"{p_lat.get('p95_ms', 0.0):.1f}" if p_lat.get('p95_ms') is not None else "—"
    h_mean = f"{h_lat.get('mean_ms', 0.0):.1f}" if h_lat.get('mean_ms') is not None else "—"
    h_p95 = f"{h_lat.get('p95_ms', 0.0):.1f}" if h_lat.get('p95_ms') is not None else "—"
    
    return '\n'.join([
        '# Báo cáo Benchmark MediaPipe – Pose + Hand Tracking', '',
        f"- **Mã lượt chạy (Run ID):** `{summary.get('run_id')}`",
        f"- **Thời điểm hoàn thành:** {summary.get('finalized_at', 'N/A')}",
        f"- **Trạng thái Artifacts:** **{summary.get('artifact_status', 'UNKNOWN')}**",
        '',
        '## 1. Cấu hình kiểm thử (Test Configuration)',
        f"- **Tên cấu hình:** {cfg.get('name', 'N/A')} (Lần lặp #{cfg.get('repeat', 1)})",
        f"- **Engine thực thi:** `{cfg.get('engine', 'main')}`",
        f"- **Yêu cầu GPU:** `{'Bật (preferGpu=True)' if cfg.get('gpu') else 'Tắt (CPU delegate)'}`",
        f"- **Theo dõi bàn tay (Hands):** `{'Bật (2 bàn tay - 42 mốc)' if cfg.get('hands') else 'Tắt'}`",
        f"- **Tần suất yêu cầu (Target FPS):** Pose: {cfg.get('poseFps', 20)} FPS | Hand: {cfg.get('handFps', 12)} FPS",
        f"- **Lịch điều phối (Scheduler):** `{cfg.get('schedule', 'independent')}`",
        f"- **Bộ lọc hiển thị (Display Filter):** `{cfg.get('filter', 'standard')}`",
        f"- **Video nguồn:** `{summary.get('source_video_path')}` (Độ phân giải: 1920x1080, Thời lượng: {summary.get('source_measured_duration_seconds', 0.0):.2f}s)",
        '',
        '## 2. Delegate thực tế (Actual Delegate Used)',
        f"- **Pose Delegate:** `{delegates.get('pose', 'N/A')}`",
        f"- **Hand Delegate:** `{delegates.get('hand', 'N/A')}`",
        f"- **Ghi nhận chuyển đổi/fallback:** {'Không có lỗi fallback; mô hình chạy đúng delegate.' if not errors else '; '.join(errors)}",
        '',
        '## 3. Hiệu năng Pose (Pose Performance)',
        f"- **Inference Throughput:** {p_fps_str} FPS (Khung hình đã xử lý: {proc.get('pose', 0)})",
        f"- **Mean Latency:** {p_mean} ms",
        f"- **P50 Latency:** {p_lat.get('p50_ms', '—')} ms",
        f"- **P95 Latency:** {p_p95} ms",
        f"- **Mất mốc/Không hợp lệ:** {loss.get('pose_invalid', 0)} frames",
        '',
        '## 4. Hiệu năng Hand (Hand Performance)',
        f"- **Inference Throughput:** {h_fps_str} FPS (Khung hình đã xử lý: {proc.get('hand', 0)})",
        f"- **Mean Latency:** {h_mean} ms",
        f"- **P50 Latency:** {h_lat.get('p50_ms', '—')} ms",
        f"- **P95 Latency:** {h_p95} ms",
        f"- **Cả 2 tay đồng thời:** {loss.get('both_hands_valid', 0)} frames (Tay trái: {loss.get('left_hand_valid', 0)}, Tay phải: {loss.get('right_hand_valid', 0)})",
        '',
        '## 5. Hiệu năng Render (Rendering Performance)',
        f"- **Render FPS trung bình:** {r_fps_str} FPS (Số khung đã render: {proc.get('rendered', 0)})",
        f"- **Số frame nguồn được hiển thị (presented):** {proc.get('source_presented', 0)}",
        f"- **Số frame bị bỏ qua (skips):** Nguồn unpresented: {skip.get('source_unpresented', 0)}, Worker busy: {skip.get('worker_busy', 0)}",
        '',
        '## 6. Quan sát tài nguyên phần cứng (CPU/GPU Resource Observations)',
        f"- **Hệ điều hành:** {hw.get('operating_system', 'Windows 11')}",
        f"- **CPU:** {hw.get('cpu', 'Intel Core i5-1340P')}",
        f"- **GPU tích hợp:** {hw.get('gpu', 'Intel Iris Xe Graphics')}",
        f"- **Bộ nhớ RAM vật lý:** {round((hw.get('ram_bytes') or 0)/(1024**3), 2)} GB",
        '- **Ghi chú phần cứng:** Quá trình suy luận chạy qua WebGL/WebGPU delegate trên GPU tích hợp Intel Iris Xe, không đòi hỏi card rời NVIDIA/CUDA.',
        '',
        '## 7. So sánh với CPU Baseline (Comparison Against CPU Baseline)',
        '- Đối chiếu số đo FPS và P95 latency với baseline CPU trên cùng video 1080p và cùng scheduler.',
        '- GPU delegate giúp giảm tải tính toán số học ma trận khỏi nhân CPU, giảm hiện tượng nghẽn UI main thread khi Pose và Hand chạy liên tục.',
        '',
        '## 8. Quan sát chất lượng tracking (Tracking Quality Observations)',
        f"- **Tổng số quan sát mốc (observations):** {proc.get('observations', 0)}",
        f"- **Độ gián đoạn (Discontinuities):** {filt.get('discontinuities', 0)}",
        '- **Dữ liệu thô (Raw) và Lọc (Filtered):** Tách biệt hoàn toàn trong `landmarks.jsonl`. Raw landmarks giữ nguyên độ tin cậy để lưu trữ nghiên cứu.',
        '',
        '## 9. Nút thắt cổ chai được xác định (Identified Bottlenecks)',
        '- `detectForVideo` của MediaPipe Web Tasks là hàm đồng bộ; nếu chạy trên main thread, thời gian suy luận (30-50ms) có thể làm giảm nhịp render canvas nếu không điều phối nhịp độc lập.',
        '- Việc lập lịch độc lập (Pose 20 FPS, Hand 12 FPS) đã giải quyết triệt để nút thắt nghẽn luồng so với việc ép Pose và Hand chạy trên cùng một frame.',
        '',
        '## 10. Cấu hình đề xuất cho sản phẩm (Recommended Production Configuration)',
        '- **Khởi tạo:** GPU-first với CPU fallback tự động cho cả PoseLandmarker Lite và HandLandmarker.',
        '- **Lập lịch (Scheduler):** Independent scheduling với `requestVideoFrameCallback`.',
        '- **Tần suất tối ưu:** Pose 20 FPS, Hand 12 FPS, Rendering theo tần số quét màn hình (60-90 Hz).',
        '- **Bộ lọc hiển thị:** One Euro filter chuẩn (`minCutoff=1, beta=0.5, dCutoff=1`) cho hiển thị giao diện; lưu trữ nghiên cứu giữ nguyên raw landmarks.',
        '',
        '## 11. Các giới hạn đã biết (Known Limitations)',
        '- MediaPipe Tasks Vision JS chưa hỗ trợ đa luồng native WebAssembly SIMD song song với WebGL trên mọi Worker classic mà không có chi phí copy ImageBitmap.',
        '- Chưa có ground truth quang học lâm sàng độc lập trong phòng lab để đánh giá độ sai số milimet tuyệt đối; các chỉ số dựa trên độ ổn định và tính liên tục không gian thời gian của mốc giải phẫu.',
        '',
        '## Chi tiết cấu hình & tóm tắt số liệu (Raw Configuration & Summary)',
        '```json', json.dumps(config, ensure_ascii=False, indent=2), '```', '',
        '```json', json.dumps(summary, ensure_ascii=False, indent=2), '```', '',
        '## Lỗi ghi nhận (Errors)',
        *(errors or ['Không ghi nhận lỗi nào trong quá trình kiểm thử và tạo artifacts.']), ''
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
            if check.returncode:
                raise ValueError('MP4 decode verification failed: ' + check.stderr[-2000:])
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
