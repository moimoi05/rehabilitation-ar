# AGENTS.md — Rehabilitation AR

> Hướng dẫn cho Gemini/Codex khi làm việc với `moimoi05/rehabilitation-ar`.
> **Ưu tiên:** đúng nghiệp vụ, sửa ít, giữ BE/FE chạy, không over-engineering hay over-testing. Yêu cầu trực tiếp của người dùng luôn được ưu tiên.

## 1. Giới thiệu và mục tiêu

**Rehabilitation AR** là web hỗ trợ **đánh giá và luyện tập phục hồi chức năng chi trên** tại bệnh viện. Bệnh nhân tập trước **một webcam phía trước**; điều dưỡng/kỹ thuật viên setup camera và hỗ trợ, bác sĩ quyết định chuyên môn.

Mục tiêu: quản lý một hồ sơ xuyên suốt **đến khám → đánh giá đầu vào → nhập viện (nếu cần) → luyện tập hằng ngày → báo cáo**, không mất kết quả **Baseline** và có thể mở rộng nghiên cứu AI sau này.

**Hiện trạng:** Repository đã có 5 phân hệ, MediaPipe Pose/Hand, Ghost Silhouette, game Hái hoa và lưu kết quả. Có công cụ capture nghiên cứu riêng, nhưng **chưa tự động ghi video/landmarks cho tất cả game lâm sàng**. Chưa có AI tự chấm FMA-UE, chẩn đoán hay kê bài tập. Chỉ dùng **dữ liệu giả lập**; chưa đủ bảo mật/phân quyền để sử dụng dữ liệu bệnh nhân thật.

## 2. Chức năng và mục tiêu từng phân hệ

| Phân hệ | Mục tiêu và chức năng chính |
|---|---|
| **Tổng quan** `/` | Thống kê bệnh nhân đến khám/điều trị, lượt đánh giá, buổi tập, hoạt động gần đây. Chỉ hiển thị dữ liệu API thực. |
| **Đánh giá** `/assessment` | Tiếp nhận bệnh nhân đến khám; nhập hồ sơ và câu hỏi lâm sàng, setup camera, chọn bài test/game, thực hiện, lưu kết quả. Mỗi lần khám độc lập. |
| **Luyện tập** `/training` | Tìm bệnh nhân đã nhập viện bằng mã, xem lịch sử/biểu đồ, chọn game và tập hằng ngày. **Hái hoa là game mặc định, không phải AI recommendation**. |
| **Báo cáo** `/reports` | **Đánh giá:** câu hỏi, kết quả test, Baseline, FMA-UE đã xác nhận. **Luyện tập:** buổi/game/trial, thời lượng, kết quả, biểu đồ tiến triển. |
| **Quản trị** `/admin` | Quản lý hồ sơ và hai danh sách **đến khám** (`outpatient`) / **điều trị** (`inpatient`); quản lý câu hỏi và chuyển nhóm bệnh nhân. |

### Luồng Đánh giá

`Tạo/chọn bệnh nhân → Câu hỏi lâm sàng → Setup camera/Ghost Silhouette → Danh sách bài đánh giá → Game/test → Kết quả`.

- Một bệnh nhân có nhiều lần đánh giá; lưu câu trả lời theo đúng lần khám/phiên bản bộ câu hỏi.
- Nhân viên **tự căn ghế, kiểm tra và xác nhận** Ghost Silhouette; tracking không thay bác sĩ đánh giá lâm sàng.
- Một lần đánh giá có nhiều bài/trial. **FMA-UE do chuyên gia nhập/xác nhận**, không quy đổi từ điểm game.

### Luồng Luyện tập

`Nhập mã bệnh nhân điều trị → Training Dashboard (lịch sử/biểu đồ/game mặc định) → Setup camera → Chọn game → Chơi → Kết quả`.

- **Một Training Session có nhiều game/trial**; chỉ setup camera **một lần mỗi buổi**, xác nhận lại khi camera/ghế/tư thế thay đổi.
- **Tiếp tục:** lưu kết quả, quay lại Dashboard **cùng bệnh nhân/cùng session**, cập nhật biểu đồ, chọn game tiếp. Game khác theo **chỉ định bác sĩ**.
- **Trở về:** xác nhận → **kết thúc buổi tập** (`completed`, `ended_at`) → giải phóng camera/tracking → về tìm bệnh nhân. Không tự thêm chế độ tạm dừng buổi tập.
- Mất kết nối không được tự tạo kết quả hay đánh dấu buổi tập hoàn thành.

### Chuyển từ khám sang điều trị

- Có nút chuyển nhóm ở **Quản trị và Kết quả đánh giá**, dùng **chung một backend service/API**.
- **Một bệnh nhân = một hồ sơ/mã** (`patients.research_code` duy nhất). Chỉ đổi `patient_type: outpatient → inpatient`; không xóa/tạo lại hồ sơ.
- Giữ tất cả lần khám, chọn một lần đánh giá đã hoàn tất của đúng bệnh nhân làm **Baseline**, ghi thời điểm chuyển và audit.
- Chuyển xong: không còn trong danh sách đến khám; xuất hiện ở danh sách điều trị; **Báo cáo đánh giá vẫn xem được Baseline**.

## 3. Ràng buộc kỹ thuật và lâm sàng

- Chỉ **một webcam phía trước**, không tự xây multi-camera/stereo/3D. Ghost Silhouette là **hướng dẫn căn chỉnh thủ công**, không tự xác nhận tư thế chuẩn y khoa.
- MediaPipe realtime phục vụ game; **AI phân tích offline** là hướng phát triển, không tự thêm AI chẩn đoán hoặc chỉ định điều trị.
- **Điểm game ≠ FMA-UE**. Không bịa dữ liệu biểu đồ hoặc tuyên bố đã ghi video/landmarks nếu chưa lưu và đọc lại được.
- Bảo toàn liên kết `patient → session → trial → result`, `round_id` chống trùng, calibration, Baseline và dữ liệu cũ.
- **Không** drop/reset DB, xóa PostgreSQL volume, sửa migration đã áp dụng hoặc dùng dữ liệu bệnh nhân thật trong môi trường phát triển.

## 4. Vị trí code và lệnh chạy

- **FE:** React + TypeScript + Vite; router `frontend/src/main.tsx`, pages `frontend/src/pages/`, camera/tracking/game `frontend/src/features/`.
- **BE:** FastAPI + SQLAlchemy + PostgreSQL; `backend/app/`, models `backend/app/models.py`, Alembic `backend/alembic/versions/`.
- Windows launchers cần giữ: `run-db.bat`, `run-be.bat`, `run-fe.bat`, `run-all.bat`.
- Cổng mặc định: PostgreSQL **5433**, BE **8001**, FE **5173**; health API: `/api/health`.
- Route cũ (`/patients`, `/sessions`, `/workspace`, `/results`, `/tracking-lab`) có thể phục vụ tương thích/thử nghiệm; không tự xóa chỉ vì không còn trên menu chính.

## 5. Nguyên tắc phát triển — KISS/YAGNI

1. **Minimal diff:** sửa đúng phạm vi, đọc file liên quan thay vì quét toàn repo; tái dùng component/API/model có sẵn.
2. Không tự thêm framework, dependency, abstraction, worker, microservice, AI model, pipeline, cấu hình hoặc tính năng "để dành".
3. Không rewrite tracking/camera/backend khi chỉ sửa UI, copy hoặc docs. Không tạo kế hoạch/báo cáo dài cho việc nhỏ.
4. Không commit, push, deploy, xóa dữ liệu hoặc thay đổi hạ tầng nếu chưa được yêu cầu.

## 6. Kiểm thử vừa đủ — tiết kiệm quota

**Mục tiêu chính: BE và FE vẫn chạy; chức năng vừa sửa không hỏng.** Không lấy coverage hay số lượng test làm thành tích.

- **TUYỆT ĐỐI KHÔNG TỰ TẠO LẠI `e2e/`**, Playwright tests, synthetic probes, benchmark scripts, stress/soak test suites, visual regression suites hoặc expensive CI checks. Thư mục `e2e/` đã bị xóa hoàn toàn khỏi repository.
- Không tự ý thêm test framework mới, không cài Playwright, không tạo thêm test suite chỉ để tăng test count/coverage.
- Không tự chạy full pytest/Vitest/coverage sau mọi thay đổi.
- **Docs/copy/CSS:** đọc diff, không cần test. **FE logic:** `npm run build` (hoặc targeted typecheck). **BE logic:** import/start FastAPI và kiểm tra `/api/health` nếu môi trường sẵn có.
- **Chuyển nhóm, Baseline, lưu kết quả, migration:** cần kiểm tra **nhỏ và có mục tiêu trên DB test riêng** để bảo vệ dữ liệu; không bỏ qua an toàn dữ liệu chỉ để tiết kiệm quota.
- Không dựng tất cả dịch vụ cho một thay đổi nhỏ. Nếu không chạy được kiểm tra, báo **NOT VERIFIED**, không nói đã PASS.

## 7. Cách báo cáo

Trả lời **ngắn bằng tiếng Việt**: **Đã sửa gì / Đã xác minh gì / Chưa xác minh hoặc rủi ro**. Hoàn thành yêu cầu thì dừng; không tự mở rộng nhiệm vụ.
