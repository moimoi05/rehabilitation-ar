# Báo cáo triển khai và kiểm chứng

## Phạm vi và giới hạn

Mục tiêu là MVP nghiên cứu: quản lý bệnh nhân giả danh, phiên, camera, hiệu chuẩn thủ công, theo dõi mốc, thu thập dữ liệu và trò Chạm hoa phát sáng thử nghiệm. Kết quả phần mềm không phải chẩn đoán hay đánh giá lâm sàng. AI ước lượng mức suy giảm và đề xuất cá nhân hóa chưa được triển khai. Không dùng điểm trò chơi làm điểm FMA-UE; nhãn tham chiếu do nhân viên chuyên môn đánh giá.

MVP không được đưa lên internet hoặc sử dụng dữ liệu người bệnh thật khi chưa triển khai xác thực, phân quyền, bảo vệ dữ liệu và các quy trình nghiên cứu cần thiết. Xác nhận trong phần hiệu chuẩn là thao tác thủ công, không phải chứng nhận tư thế đạt chuẩn lâm sàng.

## Chức năng trong mã nguồn

- Frontend có dashboard, quản lý hồ sơ giả danh, phiên, trang kết quả và cài đặt; đọc và ghi dữ liệu qua API. Seed gồm hồ sơ và phiên giả lập.
- Workspace hỗ trợ camera, lựa chọn thiết bị, toàn màn hình, Ghost Silhouette thủ công, lưu/khôi phục hiệu chuẩn theo phiên và cấu hình camera. Khi phục hồi cấu hình hoặc thay đổi camera/tư thế, nhân viên phải kiểm tra và xác nhận lại.
- Pose và Hand Landmarker dùng model và WASM cục bộ. Demo hiển thị mốc mô phỏng, có nhãn phân biệt và không lưu hiệu chuẩn demo.
- Trò Chạm hoa phát sáng dùng cổ tay bên tập, có lượt 30 giây hoạt động, tạm dừng khi mất mốc, dừng sớm và lưu kết quả vào phiên đang thực hiện. Demo dùng chuột/chạm và không lưu. Có thể xem các lượt đã lưu trong trang kết quả. Chỉ số trò chơi không phải FMA-UE; chưa tạo dự đoán y khoa.
- Mã nguồn có luồng capture video camera gốc, frame và landmark, cùng replay video cục bộ với nguồn `pre_recorded_video`; backend lưu metadata và xuất artifact Parquet, video và manifest. Đây là chức năng đang được kiểm chứng, không thay thế kiểm thử webcam vật lý. Xem [thu thập dữ liệu](DATA_COLLECTION.md) để biết cấu hình, giới hạn và quy trình kiểm tra.

## Kiểm chứng lịch sử MVP trước thay đổi thu thập

Các kết quả dưới đây thuộc lần triển khai MVP trước khi bổ sung capture và không chứng minh phiên bản hoặc migration hiện tại. Khi đó đã khởi chạy PostgreSQL Compose riêng trên `127.0.0.1:5433` và backend trên `127.0.0.1:8001`; `alembic upgrade head` và `alembic check` thành công, seed tạo ba hồ sơ giả lập.

| Kiểm tra | Kết quả thực chạy |
| --- | --- |
| Backend `pytest` với PostgreSQL | 11/11 đạt; integration dùng transaction rollback. Coverage `pytest-cov` 89%. |
| Frontend `npm test -- --coverage` | 47/47 bài đạt. Coverage toàn source 86,2% dòng/câu lệnh, 82,93% nhánh, 87,5% hàm; riêng Workspace đạt 79,04% nhánh và `useFlowerGame` đạt 62,5% hàm. Nhiều câu trên một dòng TSX nên số dòng không phản ánh đầy đủ hành vi được kiểm tra. |
| Frontend `npm run lint` | Đạt sau khi thêm trò chơi. |
| Frontend `npm run build` | Đạt sau khi thêm trò chơi, bao gồm `tsc -b`. |
| Frontend `npm audit --omit=dev --audit-level=high` | Không có lỗ hổng được báo cáo trong phạm vi dependency production tại thời điểm kiểm tra; không đại diện cho toàn hệ thống. |
| Playwright `cd e2e; npm test` | 6/6 đạt: các luồng bệnh nhân/phiên/hiệu chuẩn, tải model, lỗi backend; demo chạm hoa không gửi kết quả, camera và landmarks mô phỏng lưu PostgreSQL và xem kết quả. E2E tạo dữ liệu giả lập và không tự xóa. |

Có cảnh báo deprecation từ Starlette TestClient/httpx khi chạy backend test; chưa có bài kiểm thử riêng về các yêu cầu chuyển trạng thái đồng thời. Webcam, người thật và điều kiện lâm sàng chưa được kiểm thử; hãy dùng [checklist](MANUAL_TEST_CHECKLIST.md). Camera mô phỏng và demo không thay thế kiểm thử phần cứng.

## Tiếp theo

- Kiểm thử webcam, TV, ánh sáng, tốc độ xử lý và quá trình hiệu chuẩn trên thiết bị dự kiến sử dụng; ghi nhận cấu hình và kết quả thực tế.
- Hoàn thiện xác thực, phân quyền, quản trị truy cập, đồng ý tham gia và bảo vệ lưu trữ trước khi xử lý dữ liệu nghiên cứu thật.
- Kiểm tra trò chơi thử nghiệm trên thiết bị thật, mở rộng bài tập theo nhu cầu nghiên cứu và đánh giá hiệu năng, khả năng tiếp cận; giữ điểm trò chơi độc lập với FMA-UE.
- Tiếp tục kiểm chứng thu thập chuỗi mốc, validity, timestamp và giới hạn đồng bộ bằng thiết bị thật và dữ liệu tham chiếu; chỉ xây dựng AI sau khi có dữ liệu gán nhãn, quy trình đánh giá và xác nhận chuyên môn phù hợp.

Xem [README](../README.md) để khởi động, [kiến trúc](ARCHITECTURE.md), [cơ sở dữ liệu](DATABASE.md) và [MediaPipe](MEDIAPIPE.md) để biết chi tiết.
