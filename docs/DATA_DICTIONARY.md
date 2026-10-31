# Từ điển dữ liệu thu thập

Tài liệu này định nghĩa ý nghĩa nghiên cứu; schema thực tế của artifact và trường tùy chọn phải được đối chiếu với phiên bản phần mềm sinh ra file. Không tự giả định giá trị còn thiếu.

| Trường | Ý nghĩa |
| --- | --- |
| `capture_id` | Định danh lần thu; nối frame, landmark và video. |
| `patient_id`, `session_id`, `trial_id` | Khóa liên kết giả danh theo cơ sở dữ liệu. |
| `frame_id` | Chỉ số đơn điệu trong capture, không phải đồng hồ. |
| `timestamp_ms` | Thời điểm callback đầu vào frame theo đồng hồ monotonic của trình duyệt trừ `start_performance_ms` của capture, tính bằng mili giây; replay hiện tại có thể bao gồm thời gian gửi file trước khi phát. Capture cũ có thể dùng quy ước khác. |
| `video_media_time_ms` | Vị trí frame trong nguồn video tính bằng mili giây, nếu có. |
| `start_performance_ms`, `started_at_utc` | Đồng hồ monotonic và UTC khi bắt đầu capture; đồng hồ monotonic chỉ có ý nghĩa trong ngữ cảnh trang trình duyệt đó. |
| `model_config_info.recorder_start` | Mốc sự kiện bắt đầu MediaRecorder: `start_performance_ms`, `started_at_utc` và `mime_type`; chỉ có với webcam có ghi video, không phải timestamp của pixel đầu tiên. |
| `lease_expires_at` | Hạn lease theo đồng hồ PostgreSQL dùng nhận biết capture gián đoạn; không phải mốc video. Có thể null ở bản ghi cũ. |
| `artifact_summary.frames_status`, `landmarks_status`, `video_status` | Trạng thái của từng artifact khi finalize: `pending`, `complete`, `failed` hoặc `not_requested`; capture chỉ `complete` sau khi mọi artifact được yêu cầu thành công. |
| `source_frame_id`, `skipped_frames` | Bộ đếm frame trình bày do trình duyệt cung cấp hoặc ước lượng và số khoảng trống quan sát được; không phải số frame gốc được đảm bảo. |
| `inference_performed` | Có thực sự chạy model cho frame đó hay không. |
| `pose_detected`, `hand_detected` | Trạng thái phát hiện tương ứng khi đã chạy model; không đồng nghĩa độ chính xác. |
| `inference_ms` | Thời gian suy luận đo được, không phải thời điểm đầu vào. |
| `landmark_source`, `landmark_index`, `landmark_name` | Model, chỉ số và tên mốc theo model. |
| `coordinate_space` | `normalized_image` hoặc `world`; không trộn các hệ trong phân tích. |
| `x`, `y`, `z` | Giá trị model trả về trong hệ tọa độ được chỉ định. |
| `visibility`, `presence` | Giá trị model thực sự cung cấp; thiếu không có nghĩa là bằng 0. |
| `representation` | `raw` là đầu ra model; `display` là kết quả xử lý để hiển thị. |
| `is_valid`, `invalid_reason` | Cờ và lý do áp dụng theo chính sách xác thực dữ liệu, không thay thế giá trị raw. |

Trong `normalized_image`, x và y được chuẩn hóa theo kích thước ảnh, z không mặc nhiên là khoảng cách vật lý. World landmarks là hệ riêng theo định nghĩa của model; đơn vị và gốc phải được nêu theo model cụ thể. Một phép đo display smoothing không nên được dùng làm raw. Lưu metadata phiên bản model, cấu hình và độ phân giải giúp tái lập xử lý.

## Schema Parquet phiên bản hiện tại

Các trường có thể null nếu nguồn không cung cấp; `utc_time` là chuỗi thời gian ISO 8601 chứ không phải kiểu timestamp Arrow. Tất cả thời gian số là mili giây.

| Artifact | Trường | Kiểu Arrow |
| --- | --- | --- |
| Cả hai | `capture_id` | string |
| Cả hai | `patient_id`, `session_id`, `trial_id`, `frame_id` | int64 |
| Cả hai | `timestamp_ms`, `video_media_time_ms` | float64 |
| `frames.parquet` | `source_frame_id`, `skipped_frames` | int64 |
| `frames.parquet` | `utc_time` | string |
| `frames.parquet` | `inference_performed`, `pose_detected`, `hand_detected` | bool |
| `frames.parquet` | `inference_ms` | float64 |
| `landmarks.parquet` | `landmark_source`, `landmark_name`, `coordinate_space`, `invalid_reason`, `handedness`, `representation` | string |
| `landmarks.parquet` | `landmark_index` | int64 |
| `landmarks.parquet` | `x`, `y`, `z`, `visibility`, `presence` | float64 |
| `landmarks.parquet` | `is_valid` | bool |

Một hàng frame có thể không có hàng landmark tương ứng. `skipped_frames` ghi số frame nguồn bị bỏ qua giữa các mẫu khi nguồn báo được; giá trị này không bảo đảm phát hiện mọi frame camera bị mất trước khi đến trình duyệt. Một mốc có thể xuất hiện nhiều lần ở các hệ tọa độ hoặc representation khác nhau; dùng các trường này cùng index và frame ID làm khóa phân tích.

## Video manifest CSV

Manifest theo session chỉ gồm capture hoàn tất. Các cột là `capture_id`, `patient_id`, `session_id`, `trial_id`, `source_type`, `started_at_utc`, `ended_at_utc`, `duration_ms`, `width`, `height`, `model_config_json`, `video_mime_type`, `video_size_bytes`, `video_sha256`, `video_url`, `frames_url` và `landmarks_url`. Các URL là đường dẫn API tương đối, có thể để trống nếu loại artifact không được chọn. `model_config_json` là JSON được mã hóa trong một ô CSV; không giả định các khóa cấu hình luôn có mặt ở các bản capture cũ.
