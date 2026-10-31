# Kế hoạch tái cấu trúc Rehabilitation AR

Ngày audit: 31-10-2026. Tài liệu này ghi kiến trúc và kế hoạch triển khai; kết quả kiểm thử thực chạy được ghi riêng trong `IMPLEMENTATION_REPORT.md`.

## 1. Phạm vi và điều kiện bảo toàn

- Phát triển tiếp React 19/TypeScript/Vite/React Router và FastAPI/SQLAlchemy/Pydantic/Alembic/PostgreSQL; không viết lại ứng dụng.
- Giữ nguyên định danh bệnh nhân `patients.id`, mã duy nhất `research_code`, dữ liệu phiên, calibration, trial, JSON kết quả và UUID `round_id` hiện có.
- Không xóa/reset database, không xóa volume, không sửa các migration lịch sử, không commit/push/deploy.
- Tại thời điểm audit có nhiều thay đổi chưa commit về capture/replay, bao gồm `capture_runs`, lease monitor, video/Parquet và navigation guard. Đây là trạng thái đầu vào cần bảo toàn, không phải phần có thể thay thế hoặc hoàn tác.
- Không có `.codegraph` tại repository; theo AGENTS.md, dùng mã nguồn và kiểm thử trực tiếp, không tự tạo chỉ mục.
- Không suy ra FMA-UE hoặc kết luận lâm sàng từ điểm game hay landmarks. Xác nhận tư thế do nhân viên thực hiện.

## 2. Kiến trúc hiện tại

### Backend

`backend/app/main.py` đang chứa health/capabilities và API bệnh nhân, phiên, calibration, exercise result. `models.py` định nghĩa 10 bảng ban đầu và bảng capture mới. `schemas.py` kiểm tra mã nghiên cứu, bên tay, trạng thái/thời gian phiên, tọa độ hiệu chuẩn, image anchor và kết quả Flower Game. `db.py` chỉ chấp nhận PostgreSQL qua psycopg, đọc cấu hình từ `.env`.

Các điểm có thể tái sử dụng:

- Endpoint bệnh nhân cung cấp danh sách/tạo/xem/sửa và kiểm tra mã trùng bằng unique index.
- Phiên có sẵn loại `assessment`/`training`, trạng thái `draft`/`in_progress`/`completed`/`cancelled`, máy chủ gán thời gian và khóa hàng khi chuyển trạng thái.
- Calibration gắn `session_id`, có ghost/camera/mirror và `image_anchor` tùy chọn. Đường tương thích schema cũ đang hoạt động và cần giữ.
- Kết quả game khóa phiên, ghi trial + kết quả + audit cùng transaction; UUID `round_id` cung cấp idempotency, xung đột nội dung trả 409.
- Capture router và lease monitor tách riêng; staging, artifact và file video/Parquet nằm ngoài frontend public và PostgreSQL chỉ giữ metadata.

Các phần còn thiếu: phân loại và hồ sơ bệnh nhân, chuyển nhóm có baseline, questionnaire phiên bản, danh mục bài tập, chỉ định, assessment/report chuyên biệt, training dashboard và các điều kiện nghiệp vụ dùng chung giữa API mới và đường tương thích.

### Frontend

`main.tsx` khai báo router; `Layout.tsx` hiện có sáu menu Tổng quan/Bệnh nhân/Phiên tập/Camera/Kết quả/Cài đặt. `pages/` có Dashboard, Patients, PatientDetail, Sessions, Results, Settings. `services/api.ts`, `hooks/useData.ts`, `types/index.ts` là lớp API/type/loading dùng lại được. Các panel, table, modal, button và CSS hiện có phù hợp để mở rộng, không cần thay mới toàn bộ giao diện.

`features/workspace/WorkspacePage.tsx` sở hữu vòng đời camera, lựa chọn thiết bị, Pose/Hand, CPU Worker/parallel Worker, ghost, image anchor, calibration và Flower Game. `useFlowerGame.tsx` dùng cổ tay raw, có kiểm tra ngữ cảnh, tạm dừng khi mất mốc và gửi UUID chống ghi trùng. Tracking scheduler, smoothing, mapping/geometry và Worker có nhiều kiểm thử riêng. Tracking Lab/replay có capture và các phép đo thử nghiệm; giữ nguyên đường truy cập.

Workspace giải phóng camera và model khi unmount. Vì vậy không được điều hướng qua nhiều Workspace mới trong vòng lặp luyện tập; một Workspace phải được giữ mounted trong toàn bộ buổi, trong khi các bước dashboard/catalog/result thay đổi ở shell nghiệp vụ.

### Dữ liệu, seed và kiểm thử

- `app.seed` chỉ thêm ba bệnh nhân/phiên giả lập khi chưa tồn tại; không dùng seed làm dữ liệu thống kê giao diện và không chạy seed trên dữ liệu cần giữ chỉ để làm đẹp dashboard.
- Backend pytest hiện dùng PostgreSQL được truyền rõ qua `TEST_DATABASE_URL`, mỗi bài integration rollback transaction; nếu thiếu URL thì bị skip. Có unit validation, API lifecycle, image anchor compatibility và capture tests.
- Frontend có Vitest/Testing Library cho page/API, game, camera lifecycle, geometry, Worker, capture/replay; cấu hình coverage V8 đã có.
- Suite Playwright e2e cũ đã được xóa hoàn toàn để tinh giản repository.
- Tài liệu tracking chứa benchmark và giới hạn lịch sử, không được đổi thành tuyên bố đã kiểm chứng phiên bản refactor.

## 3. Kiến trúc mục tiêu

### Năm phân hệ

| Phân hệ | Đường dẫn | Trách nhiệm |
| --- | --- | --- |
| Tổng quan | `/` | Số bệnh nhân mỗi nhóm, số đánh giá/buổi tập và hoạt động gần đây từ API/PostgreSQL. |
| Đánh giá | `/assessment`, `/assessment/:patientId` | Chọn/tạo outpatient, câu hỏi, camera, nhiều bài/lượt và kết quả hoàn tất. |
| Luyện tập | `/training`, `/training/:patientId` | Tìm inpatient theo mã, dashboard/lịch sử/biểu đồ, một phiên nhiều bài/lượt và kết thúc có xác nhận. |
| Báo cáo | `/reports` | Hai nhóm báo cáo, baseline giữ sau chuyển nhóm, lọc dữ liệu thực theo bệnh nhân/game/thời gian/buổi. |
| Quản trị | `/admin`, `/admin/patients/:patientId` | Hai tab bệnh nhân, hồ sơ, lịch sử, chuyển nhóm và chỉ định. |

Giữ URL cũ (`/patients`, `/patients/:id`, `/sessions`, `/workspace`, `/results`, `/settings`, `/tracking-lab`) bằng alias/redirect hoặc màn hình tương thích. Không đưa Sessions/Workspace/Results trở lại menu chính. Cài đặt và Lab là công cụ phụ có liên kết trong phân hệ phù hợp.

### Quy tắc dữ liệu và dịch vụ

Chỉ có một bảng `patients`; `research_code` là mã bệnh nhân. `patient_type` phân biệt outpatient/inpatient. Không tạo bản sao bệnh nhân khi nhập viện. `patient_transfers` là lịch sử sự kiện, trỏ trực tiếp đến assessment session hoàn thành làm baseline, không sao chép JSON kết quả.

Tách nghiệp vụ backend theo domain thành các router/service/schema nhỏ. Duy trì shape JSON của API cũ để tránh phá frontend và kiểm thử hiện có. Kiểm tra loại bệnh nhân, trạng thái phiên, quyền thực hiện bài, calibration và idempotency ở máy chủ; frontend không phải hàng rào duy nhất.

`sessions` tiếp tục là nguồn duy nhất cho assessment và training. Mỗi lần khám tạo assessment mới; một buổi tập tạo training một lần và giữ nguyên ID qua tất cả game/trial. Không có trạng thái pause/resume. Phiên dang dở vẫn nhận biết được khi quay lại nhưng không tự hoàn tất hoặc sinh kết quả.

### Questionnaire có phiên bản

Template có mã/phiên bản và trạng thái hoạt động; question có key, nhóm, loại, bắt buộc, thứ tự, lựa chọn. Hỗ trợ text, number, date, single choice, multiple choice và boolean. Submission thuộc assessment session và lưu snapshot template/questions để thay đổi nội dung tương lai không sửa lịch sử. Answer theo question key và snapshot, được kiểm tra theo loại, lựa chọn và required. Không sửa câu trả lời của session đã kết thúc.

### Catalog, chỉ định và trial

Flower Game được đăng ký trong `exercise_catalog` theo mã hiện có `glowing_flower`, với hướng dẫn, loại, mode và trạng thái. Registry frontend ánh xạ mã exercise đến component game sẵn có. Các game bổ sung chỉ được đưa vào danh sách thực hiện khi có runtime tương ứng và chỉ định hoạt động cho bệnh nhân; không hiển thị bài chưa triển khai như thể đã chơi được.

`exercise_prescriptions` liên kết patient với catalog, người chỉ định, hướng dẫn, trạng thái và thời hạn khi có. Flower là mặc định, không là đề xuất AI. Trial thuộc session có exercise ID/code, số lượt trong phiên, thời gian và trạng thái. Trường code/JSON cũ vẫn đọc được dù chưa có FK catalog.

### Vòng đời camera và điều hướng

Workflow shell giữ Workspace mounted từ setup đến khi kết thúc buổi. Camera được kiểm tra thủ công và calibration lưu thành công trước khi bắt đầu bài. Sau game, lưu kết quả rồi cập nhật dashboard/history/chart từ API và quay về cùng shell, không tạo session hay mở camera lại. Đổi camera, ghế, vị trí, bên tay hoặc phục hồi cấu hình phải bỏ xác nhận và yêu cầu kiểm tra/lưu lại.

Nút Trở về mở dialog; hủy giữ phiên và tài nguyên hiện tại; xác nhận gọi complete, ghi `ended_at`, dừng camera/tracking/model/Worker rồi về tìm bệnh nhân. Nếu API lỗi, giữ kết quả đã lưu và cho thử lại, không báo hoàn thành giả. Rời trang vẫn áp dụng cleanup/navigation guard của capture hiện có.

## 4. Kế hoạch migration an toàn

Chuỗi tại audit: `22eb807a100b` → `4b85bc97c302` → `948b1ad2a337` → `7c01_capture_runs` → `a06f_capture_lease`. Thêm revision mới sau `a06f_capture_lease`; không đổi lịch sử, kể cả các file capture chưa commit.

| Bảng hiện tại | Thay đổi bổ sung | Cách bảo toàn |
| --- | --- | --- |
| `patients` | `patient_type`, `full_name`, `date_of_birth`, `sex`, `contact`, `admitted_at` và cờ theo dõi phân loại cũ nếu cần. | Backfill loại thành outpatient; profile thiếu để null, không tự đoán họ tên/ngày sinh/nhập viện. Giữ `research_code` unique. |
| `sessions` | Metadata chọn bài/setup workflow nếu cần. | Giữ ID, patient FK, status/type và mọi phiên cũ. |
| `calibrations` | Dùng lại, mở rộng chỉ khi cần metadata xác nhận. | Giữ session FK và legacy/image anchor. |
| `clinical_assessments` | `session_id` nullable, thông tin nhân viên xác nhận FMA-UE. | Giữ `patient_id`; không tự ghép các đánh giá cũ sang một phiên tùy ý. |
| `trials` | `exercise_id` nullable, `trial_number`, `started_at`, `ended_at`, trạng thái. | Giữ `exercise_code`; backfill metadata chỉ từ dữ liệu đủ căn cứ, không tạo thời điểm hoàn thành giả. |
| `exercise_results` | Dùng lại `result_json`, `round_id`; thêm validity khi có dữ liệu thực. | Không viết lại payload lịch sử hoặc sinh UUID thay cho kết quả cũ. |
| `landmark_records`, `video_records`, `model_predictions`, `audit_logs`, `capture_runs` | Giữ. | Không tạo bản ghi video/landmark/model giả. |

Bảng mới: `patient_transfers`, `questionnaire_templates`, `questionnaire_questions`, `questionnaire_submissions`, `questionnaire_answers`, `exercise_catalog`, `exercise_prescriptions`; bảng chọn nhiều bài cho assessment hoặc metadata workflow có thể bổ sung nếu cần.

Mỗi bảng mới có PK/FK với `RESTRICT` cho dữ liệu lâm sàng cần bảo toàn, index các FK và trường tìm/lọc; enum có check constraint; template key/version, question key, số trial và idempotency có unique constraint thích hợp. Default trong models và migration phải nhất quán để `alembic check` không phát hiện drift.

Trước upgrade: ghi Alembic revision hiện tại, row count của patients/sessions/calibrations/trials/exercise_results (và capture nếu có), danh sách FK và checksum/tập ID kết quả Flower lịch sử. Không in thông tin định danh trong log. Sau upgrade: so sánh count/ID, chạy kiểm tra orphan FK, truy vấn JSON Flower cũ và xuất danh sách mã bệnh nhân cũ cần phân loại lại thủ công. Migration chỉ thêm cấu trúc và danh mục/câu hỏi hệ thống, không tạo kết quả bệnh nhân.

Downgrade chỉ bỏ cấu trúc mới theo thứ tự FK phụ thuộc; đây có thể làm mất dữ liệu mới nên chỉ kiểm chứng ở database thử riêng. Không chạy downgrade trên database phát triển đang có dữ liệu cần giữ.

## 5. Chuyển nhóm và tính nguyên tử

Hai vị trí Quản trị và Kết quả đánh giá cùng gọi `POST /api/patients/{id}/transfer` và một service. Payload: `to_type`, `baseline_assessment_session_id`, `admitted_at`, `reason`.

Trong transaction:

1. `SELECT ... FOR UPDATE` bệnh nhân để tuần tự hóa hai yêu cầu nhập viện.
2. Kiểm tra loại hiện tại; yêu cầu cùng loại trả thông báo rõ, không thêm transfer/audit trùng.
3. Xác minh baseline đúng patient, loại assessment và status completed. Không chấp nhận baseline của người khác hoặc chưa hoàn thành.
4. Nếu không có completed assessment: mặc định chặn; policy cấu hình có thể cho ngoại lệ kèm lý do bắt buộc và ghi rõ trong lịch sử/audit.
5. Cập nhật loại/ngày nhập viện, ghi Transfer trỏ baseline, ghi Audit và commit một lần.
6. Mọi thất bại rollback toàn bộ. Không gọi helper tự commit ở giữa các bước.

Không thay patient ID, xóa hồ sơ, xóa session, di chuyển/sao chép kết quả. Danh sách theo loại phản ánh thay đổi từ cùng bảng patients sau khi reload.

## 6. Kế hoạch API

| Domain | Endpoint và hành vi |
| --- | --- |
| Tổng quan | `GET /api/dashboard` hoặc endpoint summary tương đương, aggregate trực tiếp PostgreSQL. |
| Patients | Giữ GET/POST `/api/patients`, GET/PATCH `/api/patients/{id}`; thêm lọc `patient_type`, tìm mã/tên và POST transfer. Không cho PATCH bỏ qua service chuyển loại. |
| Assessments | POST/GET `/api/assessments`, GET/PATCH `/{id}`, POST `/{id}/complete`; tạo riêng cho outpatient, chọn nhiều bài, snapshot câu hỏi và kết quả/FMA-UE xác nhận. |
| Questionnaires | GET/POST `/api/questionnaires`, GET `/{id}` và khả năng tạo phiên bản; POST/GET `/api/questionnaire-submissions`, POST `/{id}/answers`. |
| Exercises | GET `/api/exercises`, GET `/{id}`; lọc mode và khả năng thực hiện. |
| Prescriptions | GET/POST `/api/patients/{id}/prescriptions`, PATCH `/api/prescriptions/{id}`; kiểm tra bài, bệnh nhân, người chỉ định và thời hạn/trạng thái. |
| Training | POST/GET `/api/training-sessions`, GET `/{id}`, POST `/{id}/start`, POST `/{id}/complete`; tạo draft, start sau calibration, nhiều trial cùng ID. |
| Trials/results | POST `/api/trials`, GET theo session; giữ POST/GET `/api/exercise-results` với round UUID. Kết quả liên kết đúng trial/session/exercise và không tạo bản ghi trùng khi retry. |
| Reports | GET `/api/reports/assessments`, `/api/reports/training`, `/api/reports/patients/{id}`; filter mã/ID bệnh nhân, game, ngày và session; baseline vẫn truy vấn sau chuyển nhóm. |
| Compatibility | Giữ `/api/sessions`, `/api/calibrations`, `/api/capabilities`, capture và health; dùng chung validation nghiệp vụ khi thích hợp, không làm mất chức năng cũ. |

Toàn bộ input dùng Pydantic: enum/ID dương, độ dài chuỗi, ngày giờ, JSON/loại câu hỏi và giá trị hữu hạn. SQLAlchemy parameterization, không ghép SQL từ input. 404 khi không tồn tại, 409 khi mâu thuẫn nghiệp vụ/idempotency, 422 khi dữ liệu không hợp lệ. Lỗi SQL không lộ URL kết nối hay thông tin nội bộ. Mọi cập nhật quan trọng có audit không chép thông tin nhạy cảm không cần thiết.

## 7. Phân chia file dự kiến

Danh sách này là phạm vi kế hoạch, danh sách thực tế sau triển khai nằm trong báo cáo cuối.

### Backend

- Sửa `backend/app/models.py`, `schemas.py`, `main.py` theo hướng mở rộng và đăng ký router, bảo toàn các thay đổi capture.
- Tạo migration mới trong `backend/alembic/versions/` sau `a06f_capture_lease`.
- Tạo các module domain router/service/schema cho workflow, questionnaire, catalog/prescription, reports; dùng chung transfer/session/result service thay vì nhân đôi logic.
- Tạo bài kiểm thử workflow/transfer/questionnaire/reports và script kiểm tra migration/backfill report nếu cần.
- Giữ các file `captures.py`, `capture_storage.py`, `capture_schemas.py`, `capture_lease_monitor.py` trừ thay đổi tích hợp được kiểm thử riêng.

### Frontend

- Sửa `src/main.tsx`, `components/Layout.tsx`, `pages/Dashboard.tsx`, `services/api.ts`, `types/index.ts` và CSS hiện có.
- Mở rộng hoặc bọc `pages/Patients.tsx`/`PatientDetail.tsx` cho Quản trị; giữ liên kết cũ.
- Tạo các page/component workflow assessment/training, questionnaire form, transfer dialog dùng chung, danh mục, biểu đồ thời lượng và báo cáo.
- Sửa có giới hạn `features/workspace/WorkspacePage.tsx` và `useFlowerGame.tsx` để nhận context/callback từ shell; không thay thuật toán Pose/Hand, Worker/scheduler, smoothing hay phép biến đổi tọa độ.
- Tạo Vitest cho điều hướng, form, các lỗi nghiệp vụ và vòng lặp nhiều lượt.

### Tài liệu

Sửa README, `docs/ARCHITECTURE.md`, `DATABASE.md`, `IMPLEMENTATION_REPORT.md`, `MANUAL_TEST_CHECKLIST.md`. Giữ các giới hạn và bằng chứng capture/tracking lịch sử. Không lặp lại thông tin vào file top-level khác khi docs hiện tại đã có vị trí phù hợp.

## 8. Thứ tự triển khai và kiểm thử

1. Chốt audit và tài liệu này; ghi trạng thái Git đầu vào và revision/count dữ liệu, không đọc/in secret.
2. Viết test backend RED cho phân loại, mã trùng, transfer/baseline/idempotency/rollback, questionnaire snapshot/type, prescription, multi-trial và session lifecycle; chạy để xác nhận thiếu chức năng đúng nguyên nhân.
3. Mở rộng models/schema và migration bổ sung; chạy upgrade trên PostgreSQL phát triển có dữ liệu, kiểm tra count/FK/Flower lịch sử và `alembic check`.
4. Triển khai backend theo nhóm; chạy test liên quan sau mỗi nhóm, giữ test legacy. Đặc biệt kiểm tra transfer đồng thời và lỗi giữa chừng không ghi một phần.
5. Viết/chạy frontend RED cho năm menu, Quản trị, assessment/training/reports. Triển khai trên component/style/API hiện có.
6. Tích hợp Workspace bằng context/callback và vòng đời mounted; kiểm tra camera/MediaPipe/Worker cleanup, invalidation calibration, retry result và navigation guard.
7. Kiểm tra luồng giao diện: hai vị trí chuyển nhóm, questionnaire, assessment nhiều bài/lượt, training cùng session qua tiếp tục, chart reload, hủy/xác nhận kết thúc, báo cáo/baseline/filter và legacy routes.
8. Chạy kiểm tra: `pytest`, `alembic upgrade head`, `alembic check`, frontend lint/typecheck/build. Không gọi bài bị skip là đạt; ghi số test, coverage, lệnh và giới hạn môi trường.
9. Review code và bảo mật độc lập, sửa lỗi CRITICAL/HIGH, chạy lại các kiểm thử bị ảnh hưởng; cập nhật báo cáo và checklist theo kết quả thực.

Người yêu cầu đã cấm commit/push/deploy; các checkpoint TDD chỉ ghi bằng output kiểm thử và báo cáo, không tạo commit dù skill mặc định có gợi ý checkpoint Git.

## 9. Rủi ro và giới hạn cần theo dõi

- **Dữ liệu cũ:** hồ sơ không có phân loại phải là outpatient và có danh sách xem lại; không đoán inpatient từ phiên training cũ. Các clinical assessment không có session không tự gán baseline.
- **Tương thích:** legacy test có thể tạo training cho outpatient và start trước calibration; cần thiết kế đường cũ có ranh giới rõ, ưu tiên không để API tương thích trở thành cách bỏ qua quy tắc mới. Nếu hành vi phải đổi, cập nhật test theo nghiệp vụ thật và chứng minh không mất dữ liệu.
- **Camera:** remount giữa các bước làm mất stream/confirmation; callback cập nhật session hoặc result không được vô tình reset ghost hoặc game context. Bất kỳ thay đổi camera/ghế/vị trí đều phải bỏ xác nhận.
- **Trùng trial:** không để POST trial trước game rồi POST result tự tạo trial thứ hai; cùng service phải hỗ trợ liên kết trial chuẩn và retry UUID.
- **Cạnh tranh:** transfer, start/complete, lưu result phải khóa theo thứ tự nhất quán và tránh commit lồng; kiểm thử rollback và yêu cầu đồng thời trên PostgreSQL.
- **Questionnaire lịch sử:** giữ snapshot bất biến; đổi version không thay câu trả lời cũ, không lấy nhãn question hiện tại để diễn giải báo cáo cũ.
- **Biểu đồ:** dùng thời lượng/kết quả thật, trạng thái rỗng rõ ràng; không nối điểm giả hay so điểm giữa game khác thang.
- **Nghiên cứu:** code capture đã có nhưng hiệu năng/độ chính xác webcam vật lý, đồng bộ và ghi dài hạn cần kiểm chứng riêng; không dùng dữ liệu giả để tuyên bố hoàn thành.
- **Vận hành bệnh viện:** hệ thống đầu vào chưa có xác thực/phân quyền đầy đủ. Việc refactor workflow không tự biến nó thành nền tảng được phép xử lý hồ sơ thật hay được xác nhận lâm sàng; báo cáo phải ghi đúng phạm vi đã triển khai và các phần còn thiếu.

