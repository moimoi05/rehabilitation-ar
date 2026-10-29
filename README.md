# Rehabilitation AR — MVP nghiên cứu

Ứng dụng web hỗ trợ quản lý bệnh nhân giả danh, phiên tập và hiệu chuẩn tư thế bằng Ghost Silhouette trước webcam. Frontend dùng React, Vite và MediaPipe Tasks Vision; backend FastAPI lưu dữ liệu vào PostgreSQL. Xem [kiến trúc](docs/ARCHITECTURE.md), [cơ sở dữ liệu](docs/DATABASE.md), [MediaPipe](docs/MEDIAPIPE.md), [checklist kiểm thử](docs/MANUAL_TEST_CHECKLIST.md) và [báo cáo triển khai](docs/IMPLEMENTATION_REPORT.md).

**Chỉ dùng cho phát triển với dữ liệu giả lập.** MVP chưa có xác thực và phân quyền đầy đủ, chưa được xác nhận lâm sàng và không được triển khai công khai hoặc nhập dữ liệu bệnh nhân thật. Có một trò chơi thử nghiệm Chạm hoa phát sáng; AI ước lượng FMA-UE, ghi video và cá nhân hóa bài tập chưa triển khai. Điểm FMA-UE do nhân viên chuyên môn đánh giá, không suy ra từ điểm trò chơi.

## Chuẩn bị

- Windows PowerShell (hoặc điều chỉnh đường dẫn và lệnh cho hệ điều hành khác), Python 3.12, Node.js/npm và Docker Desktop có Docker Compose.
- Các cổng mặc định dành riêng cho dự án: PostgreSQL `127.0.0.1:5433`, backend `127.0.0.1:8001`, frontend `127.0.0.1:5173`. Thay cấu hình nếu máy đã dùng các cổng này.
- Webcam để thử camera thật; demo không yêu cầu webcam. Trình duyệt phải cho phép truy cập camera trên localhost.

## Cài đặt và chạy

Thực hiện từ thư mục gốc dự án. Nếu chưa có `.env`, sao chép `.env.example` thành `.env`, tạo mật khẩu phát triển riêng và điền nhất quán `POSTGRES_PASSWORD` và `DATABASE_URL`. Giữ `.env` đã có khi tiếp tục sử dụng database đã khởi tạo: sửa giá trị trong `.env` không tự đổi mật khẩu bên trong volume PostgreSQL. Không đưa `.env` vào Git. Nếu mật khẩu có ký tự đặc biệt trong URL thì mã hóa URL phù hợp. Kiểm tra `CORS_ORIGINS` cho đúng origin frontend.

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# Với cài đặt mới, mở .env và thay các giá trị cần thiết trước khi chạy tiếp.
docker compose -p rehabilitation-ar up -d postgres
```

Mở một terminal PowerShell khác cho backend:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m alembic upgrade head
.\.venv\Scripts\python -m app.seed
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

Seed chỉ dùng dữ liệu giả lập. Nếu PostgreSQL chưa sẵn sàng, chờ healthcheck rồi chạy lại migration; không xóa volume để xử lý lỗi. Mở terminal thứ ba:

```powershell
cd frontend
npm install
npm run dev
```

Truy cập `http://127.0.0.1:5173`. Backend mặc định tại `http://127.0.0.1:8001`; nếu chạy ở địa chỉ khác, đặt `VITE_API_BASE_URL` trong môi trường của terminal frontend hoặc `frontend/.env.local` trước khi chạy Vite. Kiểm tra `http://127.0.0.1:8001/api/health` và tài liệu API tại `http://127.0.0.1:8001/docs`.

Sau khi dùng, dừng các terminal ứng dụng bằng Ctrl+C. `docker compose -p rehabilitation-ar stop` dừng PostgreSQL mà giữ dữ liệu; không dùng lệnh xóa volume nếu chưa sao lưu và xác nhận phạm vi dữ liệu.

## Sử dụng

1. Tạo hoặc chọn bệnh nhân bằng mã nghiên cứu giả danh, sau đó tạo phiên đánh giá hoặc luyện tập.
2. Mở Workspace từ phiên, chọn camera, bật video và điều chỉnh hình bóng theo hướng dẫn. Nhân viên chuyên môn kiểm tra, xác nhận và lưu hiệu chuẩn; hiệu chuẩn lại khi thay đổi camera hoặc ghế.
3. Để chơi với camera, chuyển phiên sang **Đang thực hiện**, bật camera và nhận diện Pose, rồi xác nhận tư thế trong Workspace. Nhấn **Bắt đầu trò chơi** và đưa cổ tay bên tập đến hoa, sau đó rời hoa trước lần chạm tiếp theo. Lượt kéo dài 30 giây có theo dõi, hoặc có thể dừng sớm; thời gian tạm dừng khi mất mốc cổ tay.
4. Sau lượt, nhấn **Xác nhận lưu kết quả**. Nếu lưu thất bại, có thể thử lại; mở **Kết quả & báo cáo**, chọn **Xem trò chơi** ở phiên để xem lượt đã lưu. Thay đổi phiên, tay, gương, camera, nhận diện hoặc xác nhận có thể hủy lượt chưa lưu. Nếu điều kiện thay đổi khi đang lưu, kiểm tra trang kết quả vì yêu cầu có thể đã hoàn tất. Số hoa chạm là chỉ số trò chơi, không phải FMA-UE hay kết luận lâm sàng.
5. Không có webcam thì chọn **Chạy demo**, bắt đầu trò chơi và di chuyển chuột hoặc chạm trong khung hình để mô phỏng cổ tay. Kết quả demo không được lưu. MediaPipe và hình bóng là công cụ hỗ trợ, không tự xác nhận tư thế lâm sàng; xem checklist để kiểm tra thiết bị thật.

## Kiểm thử

```powershell
cd backend
# Chỉ trên PostgreSQL phát triển hoặc kiểm thử đã migration.
$env:TEST_DATABASE_URL = ((Get-Content ..\.env | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1) -replace '^DATABASE_URL=', '')
.\.venv\Scripts\python -m pytest
```

Nếu không đặt `TEST_DATABASE_URL`, các bài integration PostgreSQL sẽ bị bỏ qua. Các bài này dùng transaction rollback; vẫn nên dùng database thử nghiệm riêng và không sử dụng dữ liệu thật.

```powershell
cd frontend
npm run lint
npm run typecheck
npm test
npm run build
```

Để chạy Playwright, trước tiên khởi động frontend, backend và PostgreSQL kiểm thử riêng, sau đó chạy `cd e2e`, `npm install`, `npm test`. Bộ kiểm thử sử dụng Google Chrome và camera mô phỏng, tạo hồ sơ/phiên giả lập và không tự xóa các bản ghi đó; không chạy trên database chứa dữ liệu cần giữ.

Kết quả đã thực sự chạy và những giới hạn còn lại được ghi tại [báo cáo triển khai](docs/IMPLEMENTATION_REPORT.md).
