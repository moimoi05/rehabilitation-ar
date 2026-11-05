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
| `model_config_info.tracking_recorder_start` | Mốc bắt đầu recorder video ghép tracking nếu có; không phải timestamp pixel đầu tiên hoặc bằng chứng đồng bộ từng frame. |
| `lease_expires_at` | Hạn lease theo đồng hồ PostgreSQL dùng nhận biết capture gián đoạn; không phải mốc video. Có thể null ở bản ghi cũ. |
| `artifact_summary.frames_status`, `landmarks_status`, `video_status`, `tracking_video_status` | Trạng thái riêng của từng artifact. Video tracking có thể `pending`, `complete`, `incomplete`, `failed` hoặc `not_requested`; capture chỉ `complete` sau khi các artifact được yêu cầu thành công và không có gap đã biết. |
| `artifact_summary.tracking_video_file`, `tracking_video_size_bytes`, `tracking_video_sha256` | Tên file tương đối trong thư mục capture, kích thước và SHA-256 của video tracking đã ghi; có thể thiếu nếu không thu được. Trạng thái `incomplete` không chứng minh toàn bộ video đã được thu. |
| `source_frame_id`, `skipped_frames` | Bộ đếm frame trình bày do trình duyệt cung cấp hoặc ước lượng và số khoảng trống quan sát được; không phải số frame gốc được đảm bảo. |
| `inference_performed` | Cờ tương thích lịch sử. Schema 2 là OR của hai cờ model khi cả hai đã biết; khi callback của một model đã gửi bị mất, cờ chung vẫn true nhưng cờ model có thể null, cần đọc status riêng. Không suy ngược cờ model cho dữ liệu cũ. |
| `pose_inference_performed`, `hand_inference_performed` | Model tương ứng có thực sự chạy; false là không chạy, null là không xác minh được kết quả/thực thi của dispatch. |
| `pose_inference_status`, `hand_inference_status` | Phân biệt `not_run`, `detected`, `not_detected`, `error`, `missing_result`; xem bảng trạng thái bên dưới. |
| `pose_detected`, `hand_detected` | Trạng thái phát hiện tương ứng khi đã chạy model; không đồng nghĩa độ chính xác. |
| `inference_ms` | Thời gian suy luận đo được, không phải thời điểm đầu vào. |
| `pose_inference_ms`, `hand_inference_ms` | Thời lượng từng model nếu đo được; null không phải 0. Cờ chung `inference_ms` của observation mới là tổng phần đo được, không phải độ trễ đầu-cuối. |
| `pose_error`, `hand_error` | Lỗi model nếu có; thiếu kết quả không được thay bằng `detected=false`. |
| `source_observation_id` | ID main thread cấp trước inference; dùng cùng capture/frame để ghép callback lệch thứ tự. Không phải stable ID xuyên capture hoặc số thứ tự frame mã hóa. |
| `capture_mode`, `capture_schema_version` | `manual`/`per_trial` và phiên bản hợp đồng. Auto-capture mới dùng schema 2; bản ghi cũ giữ phiên bản cũ. |
| `game_started_at_ms`, `game_ended_at_ms`, `termination_reason` | Mốc gameplay tương đối với `t0` capture và lý do kết thúc; độc lập với thời điểm upload và trạng thái trial. |
| `known_data_gaps` | Các phần thiếu/gián đoạn đã biết; không coi việc vắng trường này ở dữ liệu cũ là bằng chứng thu đầy đủ. |
| `landmark_source`, `landmark_index`, `landmark_name` | Model, chỉ số và tên mốc theo model. |
| `coordinate_space` | `normalized_image` hoặc `world`; không trộn các hệ trong phân tích. |
| `x`, `y`, `z` | Giá trị model trả về trong hệ tọa độ được chỉ định. |
| `visibility`, `presence` | Giá trị model thực sự cung cấp; thiếu không có nghĩa là bằng 0. |
| `handedness`, `handedness_score` | Nhãn và score do model trả về cho tay trong observation; không suy ra từ bên ảnh hưởng của bệnh nhân. |
| `hand_observation_index` | Index của bàn tay trong riêng observation, không phải định danh theo dõi ổn định xuyên video. |
| `representation` | `raw` là đầu ra model; `display` là kết quả xử lý để hiển thị. |
| `is_valid`, `invalid_reason` | Cờ và lý do áp dụng theo chính sách xác thực dữ liệu, không thay thế giá trị raw. |

Trong `normalized_image`, x và y được chuẩn hóa theo kích thước ảnh, z không mặc nhiên là khoảng cách vật lý. World landmarks là hệ riêng theo định nghĩa của model; đơn vị và gốc phải được nêu theo model cụ thể. Một phép đo display smoothing không nên được dùng làm raw. Lưu metadata phiên bản model, cấu hình và độ phân giải giúp tái lập xử lý.

Schema 2 giữ mọi landmark raw thực tế: toàn bộ 33 Pose và 21 điểm mỗi Hand khi model trả về. Không bù frame thiếu bằng landmark cũ và không tự tạo world/confidence. `is_valid` chỉ kiểm tra xyz hữu hạn và x/y trong [0,1] với normalized-image; world chỉ kiểm tra hữu hạn. Visibility/presence được lưu nhưng không dùng làm ngưỡng validity. Điểm ngoài ảnh có `outside_image`; thiếu/số không hữu hạn có `non_finite`, thành phần không hữu hạn lưu null. Đây không phải chứng nhận landmark đã được quan sát đúng hay tư thế đạt chuẩn y khoa.

| Status model | Performed | Detected | Ý nghĩa |
| --- | --- | --- | --- |
| `not_run` | false | null | Model không chạy cho observation. |
| `detected` | true | true | Có đầu ra landmark model thực tế. |
| `not_detected` | true | false | Model chạy và trả về không phát hiện. |
| `error` | true/false/null theo thông tin thực tế | null | Inference lỗi hoặc model không khả dụng; xem error. |
| `missing_result` | null hoặc true khi summary xác nhận thực thi | null | Thiếu payload kết quả trong giới hạn ghép. Nếu không có xác nhận thực thi thì không chứng minh model đã chạy. |

Timestamp worker luôn giữ thời điểm nguồn main thread. `video_media_time_ms` là media time nguồn quan sát, chưa ánh xạ chính xác tới encoded PTS. `manifest.json` ghi rõ sai số đồng bộ chưa đo và observation ID không khớp 1:1 với frame MediaRecorder.

## Schema Parquet phiên bản hiện tại

Các trường có thể null nếu nguồn không cung cấp; `utc_time` là chuỗi thời gian ISO 8601 chứ không phải kiểu timestamp Arrow. Tất cả thời gian số là mili giây.

| Artifact | Trường | Kiểu Arrow |
| --- | --- | --- |
| Cả hai | `capture_id` | string |
| Cả hai | `patient_id`, `session_id`, `trial_id`, `frame_id` | int64 |
| Cả hai | `timestamp_ms`, `video_media_time_ms` | float64 |
| `frames.parquet` | `source_frame_id`, `source_observation_id`, `skipped_frames` | int64 |
| `frames.parquet` | `utc_time` | string |
| `frames.parquet` | `inference_performed`, `pose_detected`, `hand_detected`, `pose_inference_performed`, `hand_inference_performed` | bool |
| `frames.parquet` | `inference_ms`, `pose_inference_ms`, `hand_inference_ms` | float64 |
| `frames.parquet` | `pose_inference_status`, `hand_inference_status`, `pose_error`, `hand_error` | string |
| `landmarks.parquet` | `landmark_source`, `landmark_name`, `coordinate_space`, `invalid_reason`, `handedness`, `representation` | string |
| `landmarks.parquet` | `landmark_index`, `hand_observation_index` | int64 |
| `landmarks.parquet` | `x`, `y`, `z`, `visibility`, `presence`, `handedness_score` | float64 |
| `landmarks.parquet` | `is_valid` | bool |

Một hàng frame có thể không có hàng landmark tương ứng. `skipped_frames` ghi số frame nguồn bị bỏ qua giữa các mẫu khi nguồn báo được; giá trị này không bảo đảm phát hiện mọi frame camera bị mất trước khi đến trình duyệt. Một mốc có thể xuất hiện nhiều lần ở các hệ tọa độ hoặc representation khác nhau; dùng các trường này cùng index và frame ID làm khóa phân tích.

Đối với nhiều bàn tay, thêm `hand_observation_index` vào khóa phân tích cùng `capture_id`, `frame_id`, `landmark_source`, `landmark_index`, `coordinate_space`, `representation`. Các cột schema 2 không có trong file lịch sử không được tự gán giá trị suy đoán. Snapshot model/nhiệm vụ/hiệu chuẩn nằm trong `model_config_info` PostgreSQL và `configuration` của manifest; thông tin không đo được có thể null.

## Manifest JSON theo capture

`REHAB_DATA_DIR/<capture_uuid>/manifest.json` lưu `capture_schema_version`, `capture_mode`, các ID, source, consent, configuration, mốc capture/game, trạng thái, lỗi, `known_data_gaps`, synchronization và validity/hand identity policy. `model_status_counts` đếm trạng thái của từng model; `missing_result_summary` lưu count, `first_timestamp_ms`, `last_timestamp_ms` cho observation thiếu kết quả. Mỗi phần tử `artifacts` mô tả `kind`, `name`, `status`, `size_bytes`, `sha256`, `record_count` (video không có số hàng Parquet). Byte/checksum manifest nằm ngoài file, tại `artifact_summary.manifest_size_bytes`/`manifest_sha256`. Chỉ trạng thái artifact complete mới chứng minh file đã được ghi và kiểm tra tại finalize; không chứng minh độ chính xác tracking hoặc đồng bộ video.

Artifact `video` là video camera nguồn; `tracking_video` là video riêng ghép camera với lớp phủ tracking realtime. Auto-capture mới chỉ yêu cầu video tracking khi đã xác nhận cả video và landmark. Tên `tracking_video.webm`, `.mp4` hoặc `.ogv` theo MIME ghi; dữ liệu cũ không tự có artifact này. File tracking `incomplete` có thể được cung cấp để kiểm tra khi tồn tại, song không được coi là hoàn chỉnh. Mỗi video có trạng thái và checksum riêng; lớp phủ có thể làm mượt/trễ và không thay thế landmark raw hay chứng minh đồng bộ chính xác từng frame.

## Video manifest CSV

Manifest theo session chỉ gồm capture hoàn tất. Các cột là `capture_id`, `patient_id`, `session_id`, `trial_id`, `source_type`, `started_at_utc`, `ended_at_utc`, `duration_ms`, `width`, `height`, `model_config_json`, `video_mime_type`, `video_size_bytes`, `video_sha256`, `video_url`, `frames_url` và `landmarks_url`. Các URL là đường dẫn API tương đối, có thể để trống nếu loại artifact không được chọn. `model_config_json` là JSON được mã hóa trong một ô CSV; không giả định các khóa cấu hình luôn có mặt ở các bản capture cũ.
