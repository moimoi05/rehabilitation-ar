# Rehabilitation AR — Quy trình phục hồi chức năng chi trên

Ứng dụng gồm năm phân hệ: **Tổng quan, Đánh giá, Luyện tập, Báo cáo, Quản trị**. Frontend React/Vite tái sử dụng Workspace, Ghost Silhouette và MediaPipe Pose/Hand; FastAPI lưu dữ liệu trong PostgreSQL. Xem [kế hoạch refactor](docs/REFACTOR_PLAN.md), [kiến trúc](docs/ARCHITECTURE.md), [database](docs/DATABASE.md), [MediaPipe](docs/MEDIAPIPE.md), [checklist](docs/MANUAL_TEST_CHECKLIST.md) và [báo cáo triển khai](docs/IMPLEMENTATION_REPORT.md).

**Chỉ dùng cho phát triển với dữ liệu giả lập.** Chưa có xác thực/phân quyền đầy đủ hoặc xác nhận lâm sàng. Hồ sơ hỗ trợ tên, ngày sinh, giới tính và liên hệ, nhưng chưa được nhập dữ liệu bệnh nhân thật hoặc triển khai công khai. FMA-UE chỉ được nhân viên chuyên môn nhập và xác nhận; không suy ra từ trò chơi. Công cụ thu video/landmark nghiên cứu riêng đã có tại Workspace cũ và Tracking Test Lab; Hái hoa và Vẽ tự do hỗ trợ capture nghiên cứu tự động theo trial khi được cấu hình và đồng ý. Không có AI chẩn đoán, tự chấm FMA-UE hay tự chỉ định điều trị.

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

Seed chỉ dùng dữ liệu giả lập và là tùy chọn; migration tự tạo danh mục Flower và bộ câu hỏi mặc định, không tạo bệnh nhân hay kết quả. Nếu PostgreSQL chưa sẵn sàng, chờ healthcheck rồi chạy lại migration. Giữ volume và kiểm tra health thay vì reset dữ liệu. Mở terminal thứ ba:

```powershell
cd frontend
npm install
npm run dev
```

Truy cập `http://127.0.0.1:5173`. Backend mặc định tại `http://127.0.0.1:8001`; nếu chạy ở địa chỉ khác, đặt `VITE_API_BASE_URL` trong môi trường của terminal frontend hoặc `frontend/.env.local` trước khi chạy Vite. Kiểm tra `http://127.0.0.1:8001/api/health` và tài liệu API tại `http://127.0.0.1:8001/docs`.

Sau khi dùng, dừng các terminal ứng dụng bằng Ctrl+C. `docker compose -p rehabilitation-ar stop` dừng PostgreSQL mà giữ dữ liệu; không dùng lệnh xóa volume nếu chưa sao lưu và xác nhận phạm vi dữ liệu.

## Sử dụng

1. **Quản trị:** tạo/tìm/sửa hồ sơ trong một bảng `patients`. Mã bệnh nhân là `research_code` duy nhất. Hai tab phân biệt bệnh nhân đến khám và điều trị; chuyển nhóm dùng cùng API với trang kết quả đánh giá.
2. **Đánh giá:** chọn/tạo hồ sơ đến khám → bắt đầu lần khám mới → trả lời bộ câu hỏi theo phiên bản → camera, hình bóng và xác nhận thủ công → lưu hiệu chuẩn → chọn nhiều bài → thực hiện/lưu các lượt → tổng kết, FMA-UE chuyên môn nếu có → hoàn tất. Mỗi lần khám giữ một bộ câu trả lời và lịch sử riêng.
3. **Nhập viện:** chọn đánh giá đã hoàn tất của đúng người bệnh làm Baseline. Chuyển nhóm giữ nguyên bệnh nhân và kết quả. Thiếu Baseline bị chặn mặc định; `ALLOW_TRANSFER_WITHOUT_BASELINE=true` chỉ mở ngoại lệ khi nhân viên xác nhận và ghi lý do.
4. **Luyện tập:** tìm chính xác mã bệnh nhân điều trị → xem lịch sử/biểu đồ và chỉ định → bắt đầu buổi mới → setup camera một lần → chọn game → thực hiện → xác nhận lưu → **Tiếp tục** trở lại dashboard trong cùng buổi. **Trở về** yêu cầu xác nhận kết thúc, ghi `ended_at` và giải phóng camera/models. Hủy hộp thoại giữ buổi đang hoạt động.
5. **Danh mục:** Hái hoa là mặc định 30 giây hoạt động, không phải đề xuất AI. Biến thể Hái hoa · Luyện tầm với dùng cùng cơ chế với 45 giây và cần chỉ định riêng khi luyện tập. Các bài khác không tự xuất hiện trong danh sách có thể thực hiện. Điểm các game được trình bày riêng.
6. **Báo cáo:** xem đánh giá/Baseline sau chuyển nhóm, câu hỏi theo snapshot, FMA-UE đã xác nhận, lịch sử/trial và biểu đồ thời lượng thực; lọc theo người bệnh, ngày, game, buổi. Video/artifact chỉ hiện khi có capture thực đã liên kết với trial.

Thay camera, gương, hình bóng, ghế/tư thế hoặc khôi phục cấu hình sẽ yêu cầu kiểm tra và lưu lại. Dùng **Kiểm tra lại ghế và tư thế** khi nhân viên di chuyển người bệnh. MediaPipe không tự xác nhận tư thế đạt chuẩn lâm sàng. Mất mốc tạm dừng đồng hồ game, không tạo trạng thái tạm dừng buổi tập.

Đóng trình duyệt/mất kết nối không tự hoàn tất buổi và không tạo kết quả cho lượt chưa xong. Khi quay lại, dashboard hiển thị buổi dang dở; nhân viên có thể đóng buổi đó với xác nhận rồi bắt đầu buổi mới. Không có tính năng tạm dừng/khôi phục buổi trong phiên bản này.

Các URL cũ `/patients`, `/sessions`, `/workspace`, `/results`, `/settings`, `/tracking-lab` vẫn được giữ để đọc dữ liệu cũ và thử nghiệm thiết bị; không là menu chính. Tạo luyện tập qua API cũ vẫn phải dùng bệnh nhân điều trị và đi qua cùng service của quy trình mới. Demo tại Workspace cũ không lưu kết quả.

## Migration có dữ liệu

Chuỗi hiện tại kết thúc tại `b10f_hospital_workflows`, sau `a06f_capture_lease`. Migration chỉ thêm bảng/cột/ràng buộc, giữ JSON kết quả, `round_id`, session, calibration và dữ liệu nghiên cứu cũ. Hồ sơ cũ được phân nhóm `outpatient` và đánh dấu cần xác nhận thủ công; không suy đoán nhập viện từ lịch sử game.

Tại `backend`, sao lưu PostgreSQL rồi ghi snapshot trước và sau:

```powershell
.\.venv\Scripts\python -m app.migration_audit --output ..\rehab-data\validation\before.json
.\.venv\Scripts\python -m alembic upgrade head
.\.venv\Scripts\python -m alembic check
.\.venv\Scripts\python -m app.migration_audit --output ..\rehab-data\validation\after.json --compare ..\rehab-data\validation\before.json
```

Snapshot xuất số lượng, hash trường cũ, kiểm tra khóa ngoại và các mã cần phân loại lại; không xuất họ tên, liên hệ hay JSON kết quả thô. Báo cáo mã cần xem lại cũng có tại `GET /api/reports/patient-classification`. Downgrade từ chối xóa dữ liệu workflow, hồ sơ mở rộng hoặc cấu hình mới đã tạo; phải xuất/đánh giá dữ liệu trước khi rollback.

## Kiểm thử

```powershell
cd backend
# Chỉ trên PostgreSQL phát triển hoặc kiểm thử đã migration.
$env:TEST_DATABASE_URL = ((Get-Content ..\.env | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1) -replace '^DATABASE_URL=', '')
.\.venv\Scripts\python -m pytest
.\.venv\Scripts\python -m pytest --cov=app --cov-branch --cov-report=term-missing
```

Nếu không đặt `TEST_DATABASE_URL`, các bài integration PostgreSQL sẽ bị bỏ qua. Các bài này dùng transaction rollback; vẫn nên dùng database thử nghiệm riêng và không sử dụng dữ liệu thật.

```powershell
cd frontend
npm run lint
npm run typecheck
npm test
npm test -- --coverage
npm run build
```

Có thể dùng cổng riêng: backend `8002`, frontend `5174`, `VITE_API_BASE_URL=http://127.0.0.1:8002`. Thêm origin frontend đó vào `CORS_ORIGINS` của backend trước khi khởi động. Các request thay đổi dữ liệu có Origin ngoài danh sách bị từ chối. Ngày báo cáo dùng múi giờ bệnh viện, mặc định `Asia/Bangkok` (UTC+7).

Kết quả đã thực sự chạy và những giới hạn còn lại được ghi tại [báo cáo triển khai](docs/IMPLEMENTATION_REPORT.md).
