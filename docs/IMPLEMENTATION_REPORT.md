# Báo cáo triển khai và kiểm chứng

## Refactor quy trình bệnh viện — 31/10/2026

Phần này mô tả thay đổi đang có trong worktree, tiếp tục repository hiện tại. Không commit, push hoặc deploy. Thay đổi capture/replay có từ trước được giữ lại. Bằng chứng tự động dùng dữ liệu giả lập, PostgreSQL thật và Chrome; không chứng minh độ chính xác lâm sàng hay đã kiểm thử phần cứng với người bệnh.

### 1. Kiến trúc mới

Năm phân hệ chính: Tổng quan / Đánh giá / Luyện tập / Báo cáo / Quản trị. React 19, TypeScript, Vite, Router, Tailwind và các component/styles cũ tiếp tục được dùng. `ClinicalWorkspace` giữ cùng camera/MediaPipe/Workers trong toàn buổi; nhiều trial dùng một session. FastAPI chia domain modules, dùng SQLAlchemy/Pydantic và PostgreSQL. Một bảng patients, Baseline là FK đến assessment đã hoàn tất; questionnaire có phiên bản và snapshot bất biến. Chi tiết tại [ARCHITECTURE](ARCHITECTURE.md), [DATABASE](DATABASE.md), [REFACTOR_PLAN](REFACTOR_PLAN.md).

### 2–3. Các file tạo mới và sửa

Tạo mới: **54 file** (gồm source, migration, tests, cấu hình kiểm thử và kế hoạch).

```text
backend/alembic/versions/b10f_hospital_workflows_hospital_workflows_additive_schema.py
backend/app/migration_audit.py
backend/app/questionnaires.py
backend/app/workflow_catalog.py
backend/app/workflow_common.py
backend/app/workflow_patients.py
backend/app/workflow_reports.py
backend/app/workflow_schemas.py
backend/app/workflow_sessions.py
backend/pytest.ini
backend/tests/conftest.py
backend/tests/test_request_security.py
backend/tests/test_workflow_concurrency.py
backend/tests/test_workflow_migration.py
backend/tests/test_workflow_validation.py
backend/tests/test_workflows.py
docs/REFACTOR_PLAN.md
frontend/src/components/CaptureArtifacts.test.tsx
frontend/src/components/CaptureArtifacts.tsx
frontend/src/components/DurationChart.test.tsx
frontend/src/components/DurationChart.tsx
frontend/src/components/PatientForm.test.tsx
frontend/src/components/PatientForm.tsx
frontend/src/components/TransferDialog.test.tsx
frontend/src/components/TransferDialog.tsx
frontend/src/features/rehab/ClinicalWorkspace.test.tsx
frontend/src/features/rehab/ClinicalWorkspace.tsx
frontend/src/features/rehab/ExerciseCatalog.tsx
frontend/src/features/rehab/GameResult.tsx
frontend/src/features/rehab/PatientBanner.tsx
frontend/src/features/rehab/QuestionnaireForm.test.tsx
frontend/src/features/rehab/QuestionnaireForm.tsx
frontend/src/features/rehab/SessionSummary.tsx
frontend/src/features/rehab/hospitalTime.ts
frontend/src/features/workspace/WorkspaceWorkflow.test.tsx
frontend/src/features/workspace/gameWorkflow.ts
frontend/src/features/workspace/useFlowerGameWorkflow.test.tsx
frontend/src/hooks/useData.test.tsx
frontend/src/pages/Assessment.test.tsx
frontend/src/pages/Assessment.tsx
frontend/src/pages/Training.test.tsx
frontend/src/pages/Training.tsx
frontend/src/pages/admin/PatientProfile.test.tsx
frontend/src/pages/admin/PatientProfile.tsx
frontend/src/pages/admin/PatientsAdmin.test.tsx
frontend/src/pages/admin/PatientsAdmin.tsx
frontend/src/pages/admin/QuestionnairesAdmin.test.tsx
frontend/src/pages/admin/QuestionnairesAdmin.tsx
frontend/src/pages/reports/ReportsPage.test.tsx
frontend/src/pages/reports/ReportsPage.tsx
frontend/src/rehab.css
frontend/src/services/rehab.ts
frontend/src/types/rehab.ts
```

Sửa: **28 file**.

```text
.env.example
README.md
backend/app/captures.py
backend/app/db.py
backend/app/main.py
backend/app/models.py
backend/app/schemas.py
backend/requirements.txt
backend/tests/test_api.py
docs/ARCHITECTURE.md
docs/DATABASE.md
docs/IMPLEMENTATION_REPORT.md
docs/MANUAL_TEST_CHECKLIST.md
frontend/src/components/Layout.test.tsx
frontend/src/components/Layout.tsx
frontend/src/features/workspace/WorkspacePage.tsx
frontend/src/features/workspace/flowerGame.test.ts
frontend/src/features/workspace/flowerGame.ts
frontend/src/features/workspace/useFlowerGame.tsx
frontend/src/features/workspace/workspace.css
frontend/src/hooks/useData.ts
frontend/src/main.tsx
frontend/src/pages/Dashboard.test.tsx
frontend/src/pages/Dashboard.tsx
frontend/vite.config.ts
```

### 4. Alembic migrations

Migration mới duy nhất của refactor: `backend/alembic/versions/b10f_hospital_workflows_hospital_workflows_additive_schema.py` (revision `b10f_hospital_workflows`, parent `a06f_capture_lease`). Chuỗi trước đó: `22eb807a100b` → `4b85bc97c302` → `948b1ad2a337` → `7c01_capture_runs` → `a06f_capture_lease`. Các migration lịch sử này không bị sửa.

Đã chạy upgrade/check trên database phát triển có dữ liệu. Đã chạy upgrade → downgrade về a06f → upgrade trên database kiểm thử riêng có bệnh nhân/session/calibration/trial/Flower result cũ; so sánh projection/hash và FK đạt. Đã kiểm tra downgrade từ chối xóa cấu hình questionnaire do nhân viên tạo, dù chưa có lần khám. Downgrade cũng từ chối làm mất workflow/profile/clinical data mới đã sử dụng.

### 5. Mapping dữ liệu trước/sau và bảo toàn

`patients` thêm phân nhóm/profile/ngày nhập viện/cờ review; `sessions` giữ hai loại và bốn trạng thái, thêm camera revision/workflow flags; `clinical_assessments` thêm session nullable và xác nhận chuyên môn; `trials` thêm catalog FK, số lượt, UUID và thời gian/trạng thái. JSON và `round_id` của `exercise_results` giữ nguyên. Các bảng landmark/video/capture/prediction/audit tiếp tục được giữ. Các bảng mới là transfers, bốn bảng questionnaire, catalog, prescriptions và session_exercises. Mapping đầy đủ tại [DATABASE](DATABASE.md).

| Bảng đã có | Trước migration | Sau migration |
| --- | ---: | ---: |
| patients | 10 | 10 |
| sessions | 12 | 12 |
| calibrations | 22 | 22 |
| trials | 6 | 6 |
| exercise_results | 6 | 6 |
| clinical_assessments | 0 | 0 |
| landmark_records / video_records / model_predictions | 0 / 0 / 0 | 0 / 0 / 0 |
| audit_logs | 53 | 53 |

Đối chiếu từng giá trị trường cũ: không thay đổi, không mất bản ghi; FK mồ côi: 0; sáu Flower results vẫn truy vấn được. Mười hồ sơ cũ mặc định outpatient và được xuất để xem lại phân nhóm. Có pg_dump trước thay đổi trong vùng riêng `rehab-data/backups/`; báo cáo/CSV trong `rehab-data/validation/`, không đưa dữ liệu riêng vào Git. Kiểm thử tích hợp dùng database `rehabilitation_ar_refactor_test`, không ghi hồ sơ thử vào database phát triển hiện hữu.

### 6. API endpoints

Các API domain mới và bộ lọc được liệt kê đầy đủ trong [DATABASE — API nghiệp vụ mới](DATABASE.md#api-nghiệp-vụ-mới); OpenAPI trực tiếp tại `/docs`. Gồm dashboard/policy, transfer, assessments, questionnaires/submissions/answers, exercises/prescriptions, training-sessions, trials/cancel, setup invalidation, reports/classification review. API cũ giữ wire format; tạo training qua URL cũ dùng cùng service inpatient/setup. Không có đường PATCH đổi loại assessment thành training để bỏ qua quy tắc.

Mọi write có validation, lỗi nghiệp vụ rõ ràng và transaction rollback. Khóa hàng bảo vệ transfer, trạng thái session, setup revision, trial và result; UUID chống retry tạo trùng. Browser Origin không nằm trong cấu hình bị chặn trước khi endpoint thay đổi dữ liệu. Lỗi DB không đưa thông số truy vấn ra client; log pytest dùng traceback ngắn/preflight để không in dictionary chứa mật khẩu khi DB chưa chạy.

### 7. Workflows đã triển khai

- Tạo/tìm/sửa hồ sơ, hai nhóm trong Quản trị, chuyển nhóm hai chiều; nhập viện từ Quản trị và kết quả dùng chung TransferDialog/API/service, giữ đúng Baseline. Duplicate transfer trả 409 và không thêm sự kiện.
- Đánh giá mới mỗi lần khám, câu hỏi đủ sáu kiểu, bắt buộc/thứ tự/nhóm, tạo version mới trong Quản trị, snapshot lịch sử và câu trả lời theo từng lần.
- Camera live/chọn thiết bị/Ghost/image anchor/Pose/Hand/calibration/restore tái sử dụng. Xác nhận thủ công, gate lưu calibration, revision chống phản hồi chậm, nút kiểm tra lại ghế/tư thế; không tự kết luận tư thế lâm sàng.
- Chọn nhiều bài, nhiều trial; Hái hoa 30 giây và biến thể Hái hoa · Luyện tầm với 45 giây dùng cùng engine, tách catalog code. Biến thể cần chỉ định riêng trong training; không gọi là game lâm sàng mới hoặc đề xuất AI.
- FMA-UE do người chuyên môn nhập tên/xác nhận (0–66), hoàn tất assessment, xem lịch sử/Baseline sau chuyển nhóm.
- Training tìm chính xác mã inpatient, lịch sử/chart thật, chỉ định còn hiệu lực, một session qua nhiều game. Tiếp tục giữ session/camera; Trở về có xác nhận. Cancel giữ buổi, confirm ghi completed/ended_at và giải phóng camera/models. Không có trạng thái pause/resume buổi.
- Đóng trình duyệt/mất mạng giữ kết quả đã lưu, hiển thị buổi dang dở và có thao tác đóng buổi đó với xác nhận. Trial chưa xong không có kết quả giả. Lượt không có thời gian theo dõi có thể hủy để chơi lại trong cùng setup.
- Reports assessment/training, snapshot câu hỏi, FMA chuyên môn, từng trial, thời lượng, dữ liệu chưa xác nhận chất lượng, bộ lọc bệnh nhân/ngày/game/buổi và ranh giới ngày bệnh viện UTC+7. Capture/video/artifact hiện chỉ theo metadata thật đã liên kết với trial.

### 8–10. Kiểm thử thực chạy

<!-- REFACTOR_VALIDATION_RESULTS -->

Những lỗi đã tìm thấy và sửa trong kiểm chứng: thứ tự lưu lựa chọn bài trước start assessment; ORM identity map cũ sau row lock; double transfer/rollback audit; UUID và pending trial khi tracking bị hủy; lượt không có dữ liệu; cấu hình camera phản hồi chậm; day boundary UTC+7; phản hồi patient cũ ghi đè patient mới; hiển thị tay của session lịch sử; origin CSRF; downgrade xóa cấu hình mới. Selector component được đặt tên rõ để phân biệt status hiệu chuẩn với status capture, giữ nguyên kiểm tra kết quả/hành vi.

### 11. Phần chưa triển khai hoặc chưa kiểm chứng

- Chưa có AI chẩn đoán, tự chấm FMA-UE, đánh giá mức suy giảm/tư thế lâm sàng hay tự chỉ định bài tập; đây là giới hạn được yêu cầu.
- Chưa tự động thu video/chuỗi landmark theo mỗi trial của quy trình mới. Công cụ nghiên cứu capture/replay có từ trước vẫn dùng riêng; bảng và integration points được giữ. Chỉ hiển thị video đã có thực sự, không tạo video/landmark mẫu để báo hoàn tất.
- Chưa kiểm chứng webcam vật lý, người bệnh, TV/ánh sáng/hiệu năng thiết bị mục tiêu hoặc độ chính xác lâm sàng. Bộ test video nguồn cục bộ trước đây yêu cầu file video không được cung cấp; suite E2E hiện đã được dọn bỏ.
- Chưa có xác thực/phân quyền, quản trị đồng ý và bảo vệ dữ liệu đầy đủ để xử lý thông tin thật. Dùng dữ liệu giả lập và loopback; không triển khai công khai.
- Chưa có game renderer độc lập ngoài Flower; biến thể 45 giây là cấu hình của cùng game. Danh mục/chỉ định có thể mở rộng khi renderer mới được triển khai và kiểm chứng.

### 12. Khởi chạy và kiểm thử

Theo [README](../README.md): giữ `.env` hiện có, chạy Compose postgres, cài backend requirements, `alembic upgrade head`, kiểm tra `alembic check`, seed tùy chọn, chạy uvicorn trên 8001 và Vite trên 5173. Root `.env` dùng cho backend; biến `VITE_*` cần đặt trong terminal frontend hoặc `frontend/.env.local`. Khi đổi múi giờ, `HOSPITAL_TIMEZONE` và `VITE_HOSPITAL_TIMEZONE` phải giống nhau (mặc định Asia/Bangkok).

Backend: cung cấp `TEST_DATABASE_URL` của PostgreSQL kiểm thử đã migration rồi `python -m pytest --cov=app --cov-branch --cov-fail-under=80`. Frontend: lint, typecheck, npm test/coverage, build. Thư mục E2E đã được dọn bỏ; không chạy lại Playwright. [Checklist thủ công](MANUAL_TEST_CHECKLIST.md) không được đánh dấu thay cho kiểm tra phần cứng.

### 13. Rủi ro còn tồn tại

Ứng dụng vẫn là môi trường phát triển nghiên cứu; chưa phải hệ thống lâm sàng được xác nhận hoặc được bảo vệ cho dữ liệu thật. Cờ nguồn camera do client cung cấp không chứng minh nguồn thực; chất lượng dữ liệu chưa xác nhận được hiển thị trung thực. Worker/MediaPipe đã kiểm thử lifecycle nhưng vẫn cần đo trên thiết bị mục tiêu. Session bỏ dở cần nhân viên đóng; không tự hoàn thành hoặc resume. Vite có cảnh báo bundle vượt 500 kB; build thành công, có thể tách bundle trong bước tối ưu sau. Còn cảnh báo deprecation TestClient/httpx của thư viện. Không commit/push/deploy.

---

Phần bên dưới là lịch sử MVP trước refactor, không phải kết quả kiểm chứng của phiên bản mới.

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
| Playwright (trước khi dọn dẹp) | 6/6 đạt trong đợt nghiệm thu cũ; hiện toàn bộ thư mục e2e đã được xóa hoàn toàn để tinh giản repository. |

Có cảnh báo deprecation từ Starlette TestClient/httpx khi chạy backend test; chưa có bài kiểm thử riêng về các yêu cầu chuyển trạng thái đồng thời. Webcam, người thật và điều kiện lâm sàng chưa được kiểm thử; hãy dùng [checklist](MANUAL_TEST_CHECKLIST.md). Camera mô phỏng và demo không thay thế kiểm thử phần cứng.

## Tiếp theo

- Kiểm thử webcam, TV, ánh sáng, tốc độ xử lý và quá trình hiệu chuẩn trên thiết bị dự kiến sử dụng; ghi nhận cấu hình và kết quả thực tế.
- Hoàn thiện xác thực, phân quyền, quản trị truy cập, đồng ý tham gia và bảo vệ lưu trữ trước khi xử lý dữ liệu nghiên cứu thật.
- Kiểm tra trò chơi thử nghiệm trên thiết bị thật, mở rộng bài tập theo nhu cầu nghiên cứu và đánh giá hiệu năng, khả năng tiếp cận; giữ điểm trò chơi độc lập với FMA-UE.
- Tiếp tục kiểm chứng thu thập chuỗi mốc, validity, timestamp và giới hạn đồng bộ bằng thiết bị thật và dữ liệu tham chiếu; chỉ xây dựng AI sau khi có dữ liệu gán nhãn, quy trình đánh giá và xác nhận chuyên môn phù hợp.

Xem [README](../README.md) để khởi động, [kiến trúc](ARCHITECTURE.md), [cơ sở dữ liệu](DATABASE.md) và [MediaPipe](MEDIAPIPE.md) để biết chi tiết.
