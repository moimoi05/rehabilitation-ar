# MediaPipe và kiểm thử camera

## Thiết kế

Ứng dụng dùng MediaPipe Tasks Vision JavaScript cho Pose Landmarker và Hand Landmarker. Landmark và đường nối được vẽ trên Canvas phủ video. Pose cung cấp các mốc vai, khuỷu và cổ tay; Hand có 21 mốc mỗi bàn tay. Có thể bật hoặc dừng nhận diện và ẩn skeleton; thao tác căn chỉnh Ghost Silhouette thủ công không phụ thuộc vào việc tải model thành công. Nhận diện chạy bằng CPU và được giới hạn khoảng 10 lần suy luận mỗi giây, không đảm bảo tốc độ đạt mức đó. Nhận diện là hỗ trợ kỹ thuật, không tự tuyên bố tư thế đạt chuẩn lâm sàng.

Các tệp model chính thức được dự kiến đặt cục bộ:

| Tệp | Nguồn chính thức |
| --- | --- |
| `frontend/public/models/pose_landmarker_lite.task` | [Pose Landmarker Lite float16, `latest`](https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task) |
| `frontend/public/models/hand_landmarker.task` | [Hand Landmarker float16, `latest`](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task) |

SHA-256 của bản đã tải: Pose `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a`; Hand `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`. URL `latest` có thể thay đổi; dùng hash để nhận diện chính xác bản được kiểm thử.

WASM của `@mediapipe/tasks-vision` phiên bản 0.10.35 được phục vụ từ `frontend/public/mediapipe/wasm`; phiên bản package thực tế được khóa trong `frontend/package-lock.json`. Khi thay model hoặc package, kiểm tra giấy phép và xác minh lại khởi tạo, tọa độ, hiệu năng và độ đồng bộ video/overlay. Nếu thiếu model/WASM, xem thông báo trong Workspace và khôi phục tài nguyên cục bộ trước khi thử lại.

## Kiểm thử trên thiết bị thật

1. Kết nối webcam, đặt ở giữa cạnh trên TV và mở frontend qua `localhost` hoặc một nguồn bảo mật được trình duyệt cho phép truy cập camera.
2. Chọn bệnh nhân và phiên có dữ liệu giả lập, mở Workspace, cấp quyền camera và chọn thiết bị. Kiểm tra video, hướng lật và kích thước hiển thị trên TV.
3. Khởi động nhận diện Pose và Hand; đưa các bộ phận tương ứng vào khung, che camera rồi rời khung để kiểm tra trạng thái mất theo dõi. Quan sát FPS trên máy thật, không mặc định máy đạt 30 FPS.
4. Dừng nhận diện, tắt camera hoặc rời trang; kiểm tra camera được giải phóng. Đối chiếu checklist tại [MANUAL_TEST_CHECKLIST.md](MANUAL_TEST_CHECKLIST.md).

Demo sử dụng dữ liệu mô phỏng, không đại diện cho tín hiệu của bệnh nhân và không được lưu thành bản ghi lâm sàng. Không kết luận rằng webcam hay điều kiện lâm sàng đã được kiểm thử nếu chưa thực hiện các bước trên.
