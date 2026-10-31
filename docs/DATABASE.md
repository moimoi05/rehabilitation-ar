# PostgreSQL và migration

PostgreSQL là cơ sở dữ liệu duy nhất của ứng dụng. Docker Compose chạy cơ sở dữ liệu phát triển trên loopback; thông tin kết nối và mật khẩu được cấu hình trong `.env`, không lưu trong mã nguồn. Xem `.env.example` và [README](../README.md). Không dùng dữ liệu bệnh nhân thật trong phiên bản chưa có xác thực và phân quyền đầy đủ.

## Các nhóm dữ liệu

Mở rộng theo migration mới `b10f_hospital_workflows` sau `a06f_capture_lease`; các migration lịch sử trước đó giữ nguyên. Một bảng bệnh nhân tiếp tục được dùng cho toàn bộ lịch sử.

| Thành phần | Trước | Sau refactor |
| --- | --- | --- |
| `patients` | Mã giả danh, tay, ghi chú | Thêm `patient_type`, tên, ngày sinh, giới tính, liên hệ, ngày nhập viện, cờ cần phân loại lại. Mặc định an toàn outpatient. |
| `sessions` | assessment/training, 4 trạng thái | Giữ toàn bộ; thêm `managed_workflow`, `setup_confirmed`, `setup_revision`. |
| `calibrations` | Gắn session, camera, ghost, image anchor | Giữ nguyên; API workflow kiểm tra revision trước khi lưu. |
| `clinical_assessments` | Gắn patient, điểm tùy chọn | Thêm session nullable và tên/xác nhận/thời gian chuyên môn; không suy đoán session cho bản ghi cũ. |
| `trials` | Session, exercise_code | Thêm exercise FK nullable, trial_number, client UUID, thời gian, trạng thái. Số lượt cũ được backfill theo thứ tự; không tạo thời gian/kết quả giả. |
| `exercise_results` | JSON, round_id | Giữ nguyên JSON và UUID; không xóa Flower cũ. |
| `patient_transfers` | Chưa có | Sự kiện nhập/chuyển nhóm và FK đến Baseline hoàn thành của đúng bệnh nhân; không sao chép kết quả. |
| `questionnaire_templates/questions` | Chưa có | Bộ câu hỏi bất biến theo version, đủ 6 kiểu, bắt buộc, nhóm, thứ tự, lựa chọn. |
| `questionnaire_submissions/answers` | Chưa có | Gắn từng assessment, snapshot toàn bộ câu hỏi, câu trả lời có kiểu và trạng thái hoàn tất. |
| `exercise_catalog/prescriptions` | Chưa có | Danh mục và chỉ định có người chuyên môn, hiệu lực theo ngày; Flower mặc định. |
| `session_exercises` | Chưa có | Nhiều bài được chọn trong cùng assessment. |
| Các bảng nghiên cứu/audit | Đã có | Giữ nguyên `landmark_records`, `video_records`, `capture_runs`, `model_predictions`, `audit_logs`; báo cáo tham chiếu capture theo trial. |

Các FK đều bảo vệ xóa dữ liệu bằng `RESTRICT`; enum, phạm vi điểm/trạng thái/thời gian có check constraint, mã bệnh nhân/UUID/version và số lượt trong buổi có ràng buộc duy nhất. Số liệu dashboard/report lấy trực tiếp từ PostgreSQL.

| Bảng | Mục đích |
| --- | --- |
| `patients` | Mã nghiên cứu giả danh, tay bị ảnh hưởng, tay thuận và thông tin nghiên cứu cơ bản. |
| `sessions` | Phiên gắn bệnh nhân, bên tập, loại, trạng thái, thời gian và ghi chú. |
| `calibrations` | Bản hiệu chuẩn gắn phiên, camera và hình bóng; tọa độ chuẩn hóa theo khung hình. |
| `clinical_assessments` | Cấu trúc cho đánh giá chuyên môn và điểm tham chiếu FMA-UE. |
| `trials` | Lượt thực hiện bài tập thuộc phiên. |
| `landmark_records` | Metadata hoặc tham chiếu dữ liệu mốc theo trial. |
| `video_records` | Metadata hoặc tham chiếu video theo trial. |
| `capture_runs` | UUID capture, quan hệ bệnh nhân/phiên/lượt, nguồn, consent, thời gian, cấu hình model, trạng thái và tóm tắt artifact. |
| `exercise_results` | Kết quả lượt Chạm hoa phát sáng dưới dạng JSON phiên bản schema 1, liên kết một trial. |
| `model_predictions` | Cấu trúc dành cho kết quả mô hình tương lai; không tạo dự đoán giả. |
| `audit_logs` | Nhật ký thay đổi quan trọng. |

Các quan hệ, ràng buộc và index cụ thể được xác định bởi migration Alembic trong `backend/alembic/versions/`. Migration `7c01_capture_runs` thêm bảng capture, giữ lại các bảng cũ; `a06f_capture_lease` thêm `lease_expires_at` nullable và index, không tự gán lease cho các capture cũ. Metadata nằm trong PostgreSQL; file video và Parquet nằm trong vùng lưu trữ riêng `REHAB_DATA_DIR`, không có một dòng database cho từng mốc. Mốc bắt đầu recorder được lưu trong JSON cấu hình của capture webcam có ghi video, còn lease là thời hạn hoạt động theo đồng hồ PostgreSQL. Xem [thu thập dữ liệu](DATA_COLLECTION.md) và [từ điển dữ liệu](DATA_DICTIONARY.md).

## Vận hành phát triển

Sau khi thiết lập `.env` và chạy Compose, tại thư mục `backend`:

```powershell
.\.venv\Scripts\python -m alembic upgrade head
.\.venv\Scripts\python -m app.seed
```

Seed là dữ liệu giả lập. Migration thay đổi schema: kiểm tra cấu hình `DATABASE_URL` và sao lưu cơ sở dữ liệu phù hợp trước khi áp dụng vào môi trường có dữ liệu cần giữ. Để xem phiên bản hiện tại có thể dùng `.\.venv\Scripts\python -m alembic current`. Không xóa volume hoặc reset cơ sở dữ liệu hiện có để xử lý lỗi.

## API

API cung cấp health, danh sách/tạo/xem/sửa bệnh nhân và phiên, lưu/xem hiệu chuẩn, cùng `POST /api/exercise-results` và `GET /api/exercise-results?session_id=...`. Nhóm capture có tạo, heartbeat gia hạn lease, ghi mốc recorder, upload batch/chunk, finalize, recover-finalize sau hết lease, abort, xem trạng thái, danh sách theo phiên, tải artifact và manifest; chi tiết tại [DATA_COLLECTION](DATA_COLLECTION.md) và tài liệu FastAPI `/docs`. `artifact_summary` ghi trạng thái từng artifact khi finalize một phần; staging và checksum riêng cho batch/chunk nằm trên đĩa. Các endpoint capture được giới hạn localhost nhưng chưa có xác thực hoặc phân quyền người dùng; không coi giới hạn này là bảo vệ đầy đủ dữ liệu nghiên cứu. Những bảng chuẩn bị cho các giai đoạn sau không mặc nhiên có API hay chức năng hoàn chỉnh.

Kết quả mới yêu cầu phiên đang thực hiện. API ghi trial, kết quả và audit trong cùng transaction, khóa phiên khi ghi. `round_id` UUID duy nhất giúp gửi lại cùng nội dung mà không tạo bản ghi trùng; tái sử dụng mã với nội dung khác trả lỗi 409. Cờ nguồn camera do trình duyệt gửi không chứng minh được nguồn thực, vì vậy MVP chỉ dùng dữ liệu giả lập trong môi trường phát triển và không có chức năng xác thực nguồn lâm sàng.

Phiên mới được tạo ở trạng thái nháp; thời gian do máy chủ ghi. Training ghi thời điểm tạo buổi và bắt đầu thực hiện sau hiệu chuẩn. Đã có kiểm thử hai transaction PostgreSQL chuyển cùng bệnh nhân đồng thời (một thành công, một 409), rollback khi audit thất bại và kiểm tra trạng thái ORM được làm mới sau khóa.

## API nghiệp vụ mới

| Domain | Endpoint |
| --- | --- |
| Dashboard/policy | `GET /api/dashboard`, `GET /api/workflow-config` |
| Bệnh nhân | `GET/POST /api/patients`, `GET/PATCH /api/patients/{id}`; lọc `patient_type`, `search`/`q` |
| Chuyển nhóm | `POST /api/patients/{id}/transfer`, `GET /api/patients/{id}/transfers` |
| Đánh giá | `GET/POST /api/assessments`, `GET/PATCH /api/assessments/{id}`, `GET .../{id}/detail`, `POST .../{id}/start`, `POST .../{id}/complete` |
| Bộ câu hỏi | `GET/POST /api/questionnaires`, `GET /api/questionnaires/{id}`; POST luôn tạo version mới |
| Trả lời | `POST /api/questionnaire-submissions`, `GET /api/questionnaire-submissions/{id}`, `POST .../{id}/answers` |
| Bài tập | `GET /api/exercises`, `GET /api/exercises/{id}`; lọc `mode`, `patient_id` |
| Chỉ định | `GET/POST /api/patients/{id}/prescriptions`, `PATCH /api/prescriptions/{id}` |
| Luyện tập | `GET/POST /api/training-sessions`, `GET .../{id}`, `GET .../{id}/detail`, `POST .../{id}/start`, `POST .../{id}/complete` |
| Camera | `POST /api/sessions/{id}/setup/invalidate`; calibration API cũ nhận thêm `setup_revision` khi có workflow |
| Trial/kết quả | `GET/POST /api/trials`, `POST /api/trials/{id}/cancel`, `GET/POST /api/exercise-results`; kết quả mới có `trial_id` để dùng đúng trial đã bắt đầu |
| Báo cáo | `GET /api/reports/assessments`, `GET /api/reports/training`, `GET /api/reports/patients/{id}`, `GET /api/reports/patient-classification` |

Báo cáo lọc `patient_id`, `research_code`, `from_date`, `to_date`, `exercise_id`, `session_id`. Ngày được đổi sang ranh giới `HOSPITAL_TIMEZONE` (mặc định Asia/Bangkok), không cắt ngày UTC để giả làm ngày tại bệnh viện. Response detail chứa session/patient, questionnaires snapshot, clinical assessments, trials+raw JSON, results chuẩn hóa, thời lượng, Baseline, bài đã chọn và capture metadata thật.

Các response array/object cũ được giữ để tương thích; không bọc lại envelope làm hỏng client cũ. Validation sai trả 422, không tìm thấy 404, xung đột nghiệp vụ 409; lỗi database trả thông báo chung và rollback. Browser Origin ngoài cấu hình không được thay đổi dữ liệu. Đây chưa phải cơ chế xác thực hay phân quyền nhân viên.
