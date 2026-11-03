# MediaPipe Hand-first: audit cuối ngày 02-11-2026

## Phạm vi và Git

- Nhánh làm việc: `mediapipe-hand-first-gpu`.
- HEAD ban đầu và remote đã đối chiếu: `8257de2935e3c56f996dc153cb84ac45ce7ebb8e`; base `8657bee196e4c372936b96863b16b1fcbc7a32bf`.
- Cây làm việc ban đầu sạch. Không đổi nhánh, reset, force-push hoặc merge vào main.
- Chỉ sửa frontend tracking, test liên quan và tài liệu. Không đổi backend, DB, model RTMPose, scoring, FMA hay hợp đồng bệnh nhân/phiên.

## Lỗi đã xác nhận và sửa

1. Workspace dùng một ngưỡng landmark 700 ms. Nay Hand hết hạn sau 150 ms, Pose sau 250 ms; kiểm tra tuổi không âm, timestamp và generation riêng. Overlay và raw ref được xóa độc lập khi hết hạn, ngay cả khi không có inference mới. Hand không làm mượt.
2. Scheduler Workspace bị giới hạn bởi `poseFps`, trong khi lịch Worker yêu cầu Hand 30/Pose 15. Nay callback nguồn theo mức cao nhất của hai model, lịch model độc lập và chỉ tiến khi submit thành công. Balanced đổi từ Pose20/Hand12 thành Pose15/Hand30; giữ Economy15/8 và Quality30/20.
3. So sánh số thực trong scheduler có thể làm nguồn mô phỏng chính xác 30 FPS chỉ được chấp nhận 20/30 callback. Dung sai 0,5 ms tránh bỏ nhầm callback đúng hạn; test nhận đủ 30/30. Đây là kết quả unit test, không phải FPS phần cứng.
4. Stop/fallback/unmount trước đây không chờ disposal; cleanup error bị bỏ qua. Nay disposal dừng nhận frame ngay, có ACK, Promise dùng lại và timeout 1.500 ms. Barrier dùng chung giữa trang/engine chờ cả việc khởi tạo model còn dang dở. `close()` tương thích cũ cũng tham gia barrier, kể cả tùy chọn parallel hiện có.
5. Worker có thể ACK dispose trong lúc async model initialization chưa kết thúc. Worker nay chờ initialization rồi đóng model và gửi ACK. Timeout/lỗi cleanup được báo rõ và chặn khởi tạo tiếp đến khi tải lại trang. Lỗi dispatch trước khi gửi được init là trường hợp riêng: chưa có model để dọn.
6. Quan sát replay/capture Worker trước đây ghép bằng timestamp, có association được tạo cả khi submit bị từ chối và có thể đọc Pose hiển thị của frame khác. Nay Worker có request ID riêng, replay chỉ giữ một association của submit được nhận và kiểm tra toàn bộ source identity. Workspace bỏ bookkeeping capture Worker không thể tới từ UI.
7. Pose lỗi trong Workspace trước đây vẫn tiếp tục được lên lịch, sinh lặp lỗi và cập nhật React. Nay tắt riêng model hỏng, giữ stream còn hợp lệ, dừng khi không còn model hoạt động. Hand mới cũng duy trì watchdog khi Pose vắng.
8. Workspace xóa/vẽ toàn canvas mỗi rAF. Nay chỉ vẽ khi dữ liệu, độ mới, mapping, kích thước hoặc tùy chọn thay đổi; demo vẫn animate. Lab bổ sung invalidation khi đổi mirror/raw/layout. Canvas/HUD game và ánh xạ video được giữ.
9. Benchmark thiếu chốt identity/disposal đầy đủ, có khả năng tính trùng mẫu giữa hai stream và chưa tách tuổi overlay từng model. Nay mẫu model và timing frame được khử trùng; kết quả lỗi không được tính thành inference đạt/latency 0. Pipeline Worker chờ `frame_complete`, còn Hand delivery được đo riêng.

Các rủi ro hiệu năng thực trên laptop vẫn chưa được xác minh; build/test thành công không chứng minh tracking có độ trễ thấp.

## Workspace, scheduling và fallback

Workspace thực và Lab đều dùng một dedicated Worker mặc định, yêu cầu GPU riêng cho Pose/Hand, Hand chạy và gửi `hand_result` trước khi gọi Pose của cùng frame. Inference Workspace được giới hạn 1280 × 720, giữ video nguồn nguyên vẹn. Lab/replay và benchmark cho phép chọn kích thước inference riêng.

Mỗi model có deadline riêng. Không có hàng đợi ảnh: khi capture/inference đang bận, submit mới bị từ chối. Lab/benchmark đếm model đã xử lý, frame bận, callback bị throttle và frame nguồn không được trình bày riêng. Benchmark UI chọn được riêng cấu hình 720p/540p, hiển thị delegate thật cùng FPS đạt/mục tiêu.

GPU initialization thất bại thử CPU trong cùng Worker và giữ thông báo lỗi GPU theo từng model. Nếu Worker không khả dụng, fallback main thread có cảnh báo rõ và chờ cleanup trước khi bắt đầu. WebGL/canvas renderer không được dùng làm telemetry GPU. MediaPipe video inference vẫn đồng bộ: xem [hướng dẫn Hand Landmarker chính thức](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js).

Một Worker vẫn xử lý Hand/Pose nối tiếp và giữ một frame đang xử lý. Kết quả Hand của frame hiện tại không chờ Pose frame đó, nhưng tải Pose của frame trước vẫn ảnh hưởng thông lượng chung. Không cam kết Hand đạt 30 FPS khi nguồn hoặc tổng chi phí model không đáp ứng.

## Frame identity, replay và dữ liệu nghiên cứu

- `requestId` tăng cho mỗi submit được nhận; `id` là alias tương thích. Source frame ID có thể lặp khi replay/seek mà không tái sử dụng request ID.
- `sourceFrameId`, `sourceMediaTimeMs` và `sourcePerformanceMs` được giữ qua submit, `hand_result`, `pose_result`, `frame_complete` và legacy aggregate. Latency Worker truyền theo cùng epoch `performance.timeOrigin + performance.now()`; [MDN mô tả cách đồng bộ clock Window/Worker](https://developer.mozilla.org/en-US/docs/Web/API/Performance/timeOrigin).
- Tracker chỉ giữ một request; duplicate/sai identity bị loại. Replay map chỉ thêm sau submit thành công; xóa khi complete, lỗi, reset và stop. Callback generation cũ không cập nhật phiên mới.
- Replay chỉ ghép kết quả thuộc đúng source observation, giữ raw/world/handedness và source timestamp. Model không chạy có `*_detected = null`; model lỗi có `false` và không có landmark lấy từ frame cũ. Không thêm field vào payload capture backend.
- **Research capture webcam vẫn chỉ hỗ trợ engine `main`**, đúng với nút và thông báo trong UI. Worker capture chưa được bật: backend `StrictModel`/Arrow schema hiện không có trạng thái suy luận riêng cho từng model; bổ sung sẽ vượt phạm vi hợp đồng backend được phép. Đường bookkeeping Worker chết đã được bỏ, không tuyên bố hỗ trợ thu nghiên cứu Worker.
- Research main giữ raw Pose/Hand, world và handedness của chính callback nguồn; model không được chạy không được sao chép từ ref cũ. MediaRecorder tiếp tục dùng MediaStream gốc, không lấy video đã resize hoặc overlay. Không sửa `useResearchCapture`/`captureLandmarks` hay ý nghĩa dữ liệu đã lưu.

## Benchmark và giới hạn kiểm chứng

`pose_latency`/`hand_latency` dùng mẫu inference thực riêng từng model. `captureResizeTotalMs` gộp capture/resize; `transferAndDispatchMs` gộp transfer/dispatch. Tuổi delivery/overlay Hand và Pose riêng, không tính lại một mẫu chỉ vì stream kia cập nhật. Lần phát hiện Hand hợp lệ đầu tiên không phải recovery.

`model_inference_busy_ratio_percent` là tỷ lệ thời gian inference model, không phải hardware GPU utilization. `worker_utilization_percent` còn giữ dưới dạng alias deprecated, kèm giải thích cùng ý nghĩa. Không có số đo GPU utilization, nhiệt độ hay power mới.

| Cấu hình | Hand yêu cầu | Pose yêu cầu | FPS, p50/p95, busy/drop, delegate và long task thực |
| --- | ---: | ---: | --- |
| Worker 1280 × 720 | 30 | 15 | NOT VERIFIED |
| Worker 960 × 540 | 30 | 15 | NOT VERIFIED |
| Webcam trực tiếp | Theo profile | Theo profile | NOT VERIFIED |

Máy và file nguồn có sẵn. Metadata đọc từ endpoint benchmark hiện có: i5-1340P, Intel Iris Xe, khoảng 16 GB RAM; MP4 `video_test/WIN_20261101_00_59_17_Pro.mp4`, 1920 × 1080, 29,561396 giây, 487 frame, trung bình 16,514334 FPS. Nguồn 1× này không thể chứng minh Hand đạt 30 FPS.

Đã mở trang Benchmark trong Edge và xác nhận UI/source metadata. Chưa chạy được lượt đo D/E: điều khiển browser timeout, sau đó Computer Use dừng vì không xác định đủ chắc URL hiện tại để áp dụng chính sách. Không tiếp tục thao tác UI hoặc đổi cách điều khiển để vượt chốt đó. Không có số đo trước/sau trên hardware, không ghi video/camera mới và không tự tạo kết quả benchmark.

## Tệp thay đổi

| Tệp | Mục đích |
| --- | --- |
| `frontend/public/tracking-worker.js` | Echo identity, Hand-first protocol, chờ init khi dispose, giữ lỗi cleanup, tổng thời gian model thực. |
| `frontend/src/features/workspace/workerTracker.ts` | Request identity, dedupe/association một frame, disposal/barrier và legacy compatibility. |
| `frontend/src/features/workspace/videoFrameScheduler.ts` | Dung sai callback đúng 30 FPS. |
| `frontend/src/features/workspace/trackingProfiles.ts` | Balanced Hand30/Pose15, mô tả camera/inference riêng. |
| `frontend/src/features/workspace/WorkspacePage.tsx` | Freshness, watchdog, lịch độc lập, cleanup, fallback, invalidation overlay, bỏ capture Worker chết. |
| `frontend/src/features/workspace/TrackingTestLab.tsx` | Teardown, identity replay, stream failure riêng, FPS/counter và overlay invalidation. |
| `frontend/src/features/workspace/replayFrame.ts` | Không serialize landmark model chưa chạy/lỗi, giữ null/false đúng nghĩa. |
| `frontend/src/features/workspace/benchmarkEngine.ts` | Identity, split observations, cancellation, await cleanup, trạng thái model thật. |
| `frontend/src/features/workspace/benchmarkRunner.ts` | Metric riêng, dedupe, pipeline completion, busy/drop và sample counts. |
| `frontend/src/features/workspace/benchmarkArtifacts.ts` | Trả số mẫu trong latency summary. |
| `frontend/src/features/workspace/TrackingBenchmarkPage.tsx` | Chọn từng latency configuration, FPS đạt/mục tiêu và delegate. |
| `frontend/src/features/workspace/WorkspaceHandFirst.test.tsx` | Regression tích hợp Workspace, freshness/render/lifecycle/identity/capture. |
| `frontend/src/features/workspace/WorkspacePage.test.tsx` | Giữ các trường hợp cũ, cập nhật fixture theo protocol/default/UI hiện tại. |
| `frontend/src/features/workspace/WorkspaceWorkflow.test.tsx` | Fixture theo nút/checkbox workflow hiện tại, giữ test hiệu chuẩn. |
| `frontend/src/features/workspace/TrackingTestLab.test.tsx` | Regression replay/lifecycle, migrate fixture split protocol và lịch model. |
| `frontend/src/features/workspace/workerTracker.test.ts` | Identity, barrier/ACK/timeout, cancellation, fixture shutdown không rò giữa test. |
| `frontend/src/features/workspace/parallelWorkerTracker.test.ts` | FakeWorker ACK cho consumer tương thích cũ. |
| `frontend/src/features/workspace/handFirstWorker.test.ts` | FakeWorker theo shutdown mới; bảo vệ Hand-before-Pose. |
| `frontend/src/features/workspace/trackingWorkerScript.test.ts` | Test script thật cho identity, async init/dispose và lỗi cleanup. |
| `frontend/src/features/workspace/videoFrameScheduler.test.ts` | Nguồn 30 FPS được nhận đủ 30 callback. |
| `frontend/src/features/workspace/trackingProfiles.test.ts` | Balanced mới, giữ các preset còn lại. |
| `frontend/src/features/workspace/replayFrame.test.ts` | Model không chạy/lỗi không mang landmark cũ sang frame mới. |
| `frontend/src/features/workspace/benchmarkEngine.test.ts` | Identity, Hand sớm, cleanup/cancellation và lỗi model. |
| `frontend/src/features/workspace/benchmarkRunner.test.ts` | Dedupe mẫu, metric riêng, awaited cleanup và cấu hình kích thước. |
| `frontend/src/features/workspace/TrackingBenchmarkPage.test.tsx` | Tính truy cập cấu hình D/E và báo FPS/delegate. |
| `docs/TRACKING_BENCHMARK.md` | Ý nghĩa metric hiện tại và giới hạn của bảng đo lịch sử. |
| `docs/TRACKING_ARCHITECTURE.md` | Cập nhật mặc định Worker và giới hạn research capture. |
| `docs/MEDIAPIPE_HAND_FIRST_AUDIT.md` | Báo cáo audit này. |

## Xác minh

Chỉ dùng Vitest hiện có, không thêm framework, Playwright/E2E, coverage suite hoặc test backend. Một số fixture cũ đã không còn khớp HEAD ban đầu (Hand mặc định bật, nhãn delegate, split result, UI hiệu chuẩn); đã cập nhật theo hành vi thực, giữ các tình huống kiểm tra.

Các lệnh kiểm tra cuối chạy từ `frontend/` trừ `git diff --check` chạy ở repo root:

```powershell
npx vitest run src/features/workspace/WorkspaceHandFirst.test.tsx src/features/workspace/workerTracker.test.ts src/features/workspace/parallelWorkerTracker.test.ts src/features/workspace/handFirstWorker.test.ts src/features/workspace/trackingWorkerScript.test.ts src/features/workspace/videoFrameScheduler.test.ts src/features/workspace/trackingProfiles.test.ts src/features/workspace/benchmarkEngine.test.ts src/features/workspace/benchmarkRunner.test.ts src/features/workspace/TrackingBenchmarkPage.test.tsx src/features/workspace/WorkspacePage.test.tsx src/features/workspace/WorkspaceWorkflow.test.tsx src/features/workspace/TrackingTestLab.test.tsx src/features/workspace/replayFrame.test.ts src/features/workspace/ReplayTestPage.test.tsx --reporter=dot
npm run typecheck
npm run build
git diff --check
```

Kết quả cuối: Vitest **15 tệp / 205 test PASS**, typecheck **PASS**, production build **PASS**, `git diff --check` **PASS**. Vite còn cảnh báo bundle trên 500 kB và mixed static/dynamic import; không thêm dependency hay đổi chiến lược bundling trong audit này. Chưa xác minh latency, delegates trên model GPU thực, webcam và việc thu/lưu/đọc lại capture trong browser đích; test capture hiện dùng dữ liệu giả lập.
