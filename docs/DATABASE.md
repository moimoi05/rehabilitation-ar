# PostgreSQL và migration

PostgreSQL là cơ sở dữ liệu duy nhất của ứng dụng. Docker Compose chạy cơ sở dữ liệu phát triển trên loopback; thông tin kết nối và mật khẩu được cấu hình trong `.env`, không lưu trong mã nguồn. Xem `.env.example` và [README](../README.md). Không dùng dữ liệu bệnh nhân thật trong phiên bản chưa có xác thực và phân quyền đầy đủ.

## Các nhóm dữ liệu

| Bảng | Mục đích |
| --- | --- |
| `patients` | Mã nghiên cứu giả danh, tay bị ảnh hưởng, tay thuận và thông tin nghiên cứu cơ bản. |
| `sessions` | Phiên gắn bệnh nhân, bên tập, loại, trạng thái, thời gian và ghi chú. |
| `calibrations` | Bản hiệu chuẩn gắn phiên, camera và hình bóng; tọa độ chuẩn hóa theo khung hình. |
| `clinical_assessments` | Cấu trúc cho đánh giá chuyên môn và điểm tham chiếu FMA-UE. |
| `trials` | Lượt thực hiện bài tập thuộc phiên. |
| `landmark_records` | Metadata hoặc tham chiếu dữ liệu mốc trong tương lai. |
| `video_records` | Metadata hoặc tham chiếu video, không đồng nghĩa MVP đã ghi video. |
| `exercise_results` | Kết quả lượt Chạm hoa phát sáng dưới dạng JSON phiên bản schema 1, liên kết một trial. |
| `model_predictions` | Cấu trúc dành cho kết quả mô hình tương lai; không tạo dự đoán giả. |
| `audit_logs` | Nhật ký thay đổi quan trọng. |

Các quan hệ, ràng buộc và index cụ thể được xác định bởi migration Alembic trong `backend/alembic/versions/`. Dữ liệu mốc dài nên được thiết kế để lưu trong một định dạng chuỗi phù hợp và quản lý metadata trong PostgreSQL, thay vì mặc định tạo một hàng cho từng mốc ở từng frame.

## Vận hành phát triển

Sau khi thiết lập `.env` và chạy Compose, tại thư mục `backend`:

```powershell
.\.venv\Scripts\python -m alembic upgrade head
.\.venv\Scripts\python -m app.seed
```

Seed là dữ liệu giả lập. Migration thay đổi schema: kiểm tra cấu hình `DATABASE_URL` và sao lưu cơ sở dữ liệu phù hợp trước khi áp dụng vào môi trường có dữ liệu cần giữ. Để xem phiên bản hiện tại có thể dùng `.\.venv\Scripts\python -m alembic current`. Không xóa volume hoặc reset cơ sở dữ liệu hiện có để xử lý lỗi.

## API

API cung cấp health, danh sách/tạo/xem/sửa bệnh nhân và phiên, lưu/xem hiệu chuẩn, cùng `POST /api/exercise-results` và `GET /api/exercise-results?session_id=...`. Tài liệu tương tác FastAPI tại `/docs` cho biết schema và các đường dẫn đang chạy. Những bảng chuẩn bị cho các giai đoạn sau không mặc nhiên có API hay chức năng hoàn chỉnh.

Kết quả mới yêu cầu phiên đang thực hiện. API ghi trial, kết quả và audit trong cùng transaction, khóa phiên khi ghi. `round_id` UUID duy nhất giúp gửi lại cùng nội dung mà không tạo bản ghi trùng; tái sử dụng mã với nội dung khác trả lỗi 409. Cờ nguồn camera do trình duyệt gửi không chứng minh được nguồn thực, vì vậy MVP chỉ dùng dữ liệu giả lập trong môi trường phát triển và không có chức năng xác thực nguồn lâm sàng.

Phiên mới được tạo ở trạng thái nháp; máy chủ gán thời gian khi chuyển trạng thái và khóa hàng khi cập nhật để tuần tự hóa thay đổi trạng thái. Bài kiểm thử riêng về yêu cầu đồng thời chưa được thực hiện.
