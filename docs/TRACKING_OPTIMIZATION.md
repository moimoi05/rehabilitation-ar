# Tracking optimization

## Audit trước tối ưu GPU — 01-11-2026

- Mã Workspace ép `delegate: CPU`; không có kiểm tra khả năng GPU hay lý do kỹ thuật bắt buộc CPU. Lab đã thử GPU riêng cho Pose/Hand nhưng mặc định tắt và bỏ qua nguyên nhân fallback.
- `withOwnedMediaPipeLoader` gắn định danh URL và dọn đúng script của từng lần tạo model. Cần giữ helper cho document; Worker classic dùng loader khác. Khởi tạo nối tiếp tránh tranh chấp loader; generation guard đóng model hoàn thành sau khi người dùng dừng.
- `detectForVideo` đồng bộ chặn main thread cả khi dùng GPU. Render rAF riêng không làm inference bất đồng bộ. GPU cần được xác nhận bằng kết quả khởi tạo từng model, không suy từ WebGL.
- Scheduler hiện dùng callback frame video, bỏ trùng và không có hàng đợi; khoảng cách tính từ lần chạy cuối có thể làm hụt nhịp. Hand nằm dưới callback Pose nên chưa độc lập hoàn toàn. Worker giữ tối đa một capture/inference; hai Worker tạo hai bitmap độc lập, có chi phí copy và cạnh tranh tài nguyên.
- Capture nghiên cứu dùng hàng đợi upload nối tiếp giới hạn 32 MiB, báo lỗi khi đầy; không await upload trong vòng inference. Benchmark cần kho riêng, không đi qua patient/session/trial.
- One Euro giữ raw riêng, kiểm tra tọa độ/visibility và reset sau 500 ms. Quan sát rỗng trước đây chưa xóa lịch sử ngay, có thể lọc xuyên khoảng mất tracking ngắn; đã bổ sung reset riêng identity. Không đổi tham số mặc định chỉ vì hình trông mượt hơn.

Phạm vi triển khai: khởi tạo GPU-first dùng chung, nhịp Pose/Hand riêng, Balanced 20/12 FPS, benchmark video cục bộ lưu artifact và kiểm tra độc lập. Giữ model, WASM, scoring và schema bệnh nhân. Kết quả lịch sử bên dưới không đại diện cho benchmark mới.

## Những gì đã xác nhận từ phiên bản ban đầu

- `WorkspacePage.tsx` tải Pose Lite một lần khi bắt đầu theo dõi, ở `VIDEO`, `numPoses: 1`, CPU; Hand Landmarker CPU và `numHands: 2` chỉ tải khi người dùng bật lựa chọn bàn tay. Không sử dụng backend để inference từng frame.
- Một `requestAnimationFrame` riêng gọi `detectForVideo` đồng bộ trên main thread. Kiểm tra `video.currentTime` tránh chạy lại cùng giá trị thời gian, nhưng không bảo đảm khử trùng pixel frame và điều kiện 100 ms giới hạn tốc độ tối đa lý thuyết ở 10 lần/s; Pose và Hand, nếu bật, chạy nối tiếp. Vì vậy kiểm tra trùng frame đã có từ trước; tắc nghẽn không được quy cho inference trùng.
- `requestAnimationFrame` thứ hai xóa canvas và vẽ ghost và landmarks. Trạng thái mốc được giữ trong ref, còn FPS và status cập nhật khoảng một lần mỗi giây; React không cập nhật từng landmark. Canvas sử dụng kích thước theo state, không resize trong mỗi frame.
- Đo thực nghiệm pose-only trên video 1080p thấy mean khoảng 117 ms và p95 149–157 ms trên CPU headless. Đây là bằng chứng inference có chi phí đáng kể ở điều kiện đo đó, chưa chứng minh nguyên nhân duy nhất của giật hoặc chi phí overlay, webcam, GPU, hand và game. Xem [TRACKING_BENCHMARK.md](TRACKING_BENCHMARK.md).

MediaPipe mô tả các lệnh nhận diện video JavaScript là đồng bộ và có thể chặn UI; Worker có thể giúp giải phóng main thread: [MediaPipe web guidance](https://developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer/web_js). Chuyển ảnh sang `ImageBitmap` có chi phí, và hỗ trợ đồ họa trong Worker cần kiểm chứng: [MPImage API](https://developers.google.com/edge/api/mediapipe/js/tasks-vision.mpimage). Prototype Worker đã được đo riêng, nhưng khác scheduler và không gồm UI; không thể kết luận Worker/GPU nhanh hơn hoặc an toàn hơn trong sản phẩm. Xem [benchmark Worker](TRACKING_BENCHMARK.md).

## Tham khảo WonderSnap

Đã đọc `src/hands.js`, `src/app.js`, `src/logic/gestures.js`, `src/worker.js`, và `tests/camera.spec.js` trong repo tham khảo, không chỉnh sửa repo đó. Hand Landmarker dùng `VIDEO`, thử GPU rồi fallback CPU; kiểm tra `currentTime` tránh frame trùng và dùng timestamp tăng đơn điệu. Có bộ đếm FPS camera riêng FPS render, và Playwright camera fake. `src/worker.js` dựng point cloud 3D, không chạy MediaPipe. WebGL2/particle engine phục vụ nội dung 3D của WonderSnap và không phải cơ sở đủ để đưa toàn bộ kiến trúc đó vào overlay phục hồi chức năng 2D.

## Thay đổi và trade-off hiện tại

Scheduler dùng callback frame video khi có, chỉ lập lịch callback tiếp theo sau inference đồng bộ và bỏ qua frame quá ngân sách; không xếp hàng. Fallback sử dụng rAF và bộ đếm frame hoặc `currentTime` khi bộ đếm không có. Timestamp nguồn và timestamp MediaPipe được tách, timestamp inference tăng đơn điệu; reset khi seek hoặc nguồn bị xóa. Tần suất Balanced là giới hạn trên và bộ điều chỉnh có thể giảm tần suất hơn nữa dựa trên chi phí quan sát. Phép đo cho thấy việc nhường thời gian main thread giúp rAF trong harness có thêm cơ hội chạy, nhưng giảm inference FPS; không đủ dữ liệu chứng minh giảm p95 hay tăng độ chính xác.

Pose được giữ là dữ liệu raw cho logic và có bản One Euro riêng cho hiển thị; lọc theo timestamp và tự reset sau khoảng ngắt. Lọc không chứng minh hiệu quả lâm sàng, jitter hoặc độ trễ nếu chưa đo với ground truth. Mặc định calibration chạy CPU trên main thread; classic Worker CPU là lựa chọn thử nghiệm trong Settings và Workspace, có fallback main thread. Lab hỗ trợ chọn GPU trên main thread hoặc Worker CPU thử nghiệm; khi lỗi Worker, phép đo dừng trước khi fallback về CPU main thread. Prototype Worker CPU chạy được trong classic Worker trên Chromium headless; GPU có ít mẫu, còn module Worker lỗi khởi tạo. Chưa có cơ sở chọn Worker/GPU là cấu hình tối ưu nhất cho mọi thiết bị.

Lab và Camera & hiệu chuẩn có chế độ thử nghiệm tách Pose và Hand sang hai Worker CPU. Việc tách có thể giúp Pose không phải chờ Hand, nhưng cũng tạo hai bitmap và chạy hai model đồng thời, do đó có thể tăng tổng tài nguyên sử dụng. Mỗi nhánh bỏ frame khi bận và có kết quả cùng tuổi riêng; Lab cung cấp thêm thời gian suy luận riêng. Các ảnh chụp độc lập không bảo đảm cùng frame. Ở Camera & hiệu chuẩn lựa chọn này chỉ có hiệu lực trong lần mở trang hiện tại; benchmark trong tài liệu được thực hiện ở Lab, không xác nhận hiệu năng Workspace. Cần đo trực tiếp trên laptop mục tiêu và đánh giá chất lượng chuyển động trước khi quyết định sử dụng.

Với hai Worker, Auto thử nghiệm bắt đầu ở trần Pose 30 và Hand 20 FPS; nó quan sát thời gian trả kết quả và độ trễ event loop khi tab hiển thị, giảm nhịp Hand trước nếu có áp lực kéo dài, và tăng lại chậm khi ổn định. Nếu Hand không còn khả dụng, bộ điều chỉnh xét Pose. Scheduler vẫn chọn frame mới và bỏ khi Worker bận. Đây là heuristic phản hồi, không phải số đo CPU, nhiệt độ hay lượng tài nguyên còn lại của toàn máy; không bảo đảm giữ lại một tỷ lệ CPU. Trong hai lượt Lab headless, Auto cho nhịp Pose cao hơn nhưng dùng CPU Chrome cao hơn cấu hình cố định, và không kích hoạt trạng thái giảm tải; xem [benchmark](TRACKING_BENCHMARK.md).

Workspace cho phép bật trực tiếp lựa chọn yêu cầu độ phân giải camera theo profile khi camera đã đóng; cài đặt thủ công vẫn được giữ để dùng lại khi tắt lựa chọn này. Camera có thể chọn kích thước thực khác kích thước yêu cầu, và video file vẫn dùng kích thước gốc. Không tự động resize inference: kết quả thăm dò trước cho thấy đầu ra một số mốc thay đổi đáng kể khi giảm kích thước, chưa có ground truth để xác định ảnh hưởng độ chính xác.

Ghost có thể lưu thêm neo theo ảnh có phiên bản để khôi phục sau khi thay đổi bố cục; các tọa độ theo khung cũ vẫn được lưu và không bị diễn giải lại. Khả năng này cần backend và schema hỗ trợ; nếu chưa có, hệ thống vẫn lưu tọa độ cũ và báo cần căn lại khi khôi phục. Chỉ áp dụng neo khi ID camera và kích thước thực trùng bản ghi, và luôn yêu cầu kiểm tra, xác nhận lại vì camera có thể di chuyển dù metadata không đổi. Migration bổ sung nullable chưa tự chạy trên cơ sở dữ liệu hiện có.
