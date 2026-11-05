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
| `capture_mode`, `capture_schema_version` | `manual`/`per_trial` và phiên bản hợp đồng. Phase 1 dùng schema 2; auto-capture Phase 2 của hai game dùng schema 3. Bản ghi cũ giữ phiên bản và ý nghĩa cũ. |
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

## Phase 2: game events, interaction samples và metrics

Capture schema 3 giữ nguyên hợp đồng frames/landmarks/video Phase 1 và thêm ba artifact trong cùng thư mục UUID: `events.parquet`, `interaction_samples.parquet`, `game_metrics.json`. Không có migration DB mới: phiên bản đã là cột số nguyên, metadata dùng `artifact_summary` hiện có. Schema 1/2 không bị yêu cầu bổ sung artifact hoặc diễn giải lại dữ liệu cũ.

### Các cột Parquet mới

Wire JSON dùng `payload` object; Parquet lưu cùng object dưới dạng chuỗi JSON UTF-8 trong `payload_json`. Các tọa độ/chế độ/ID đối tượng game thuộc payload, không phải cột landmark. Mỗi hàng có thể nối về patient/session/trial/capture; không đưa toàn bộ Pose/Hand vào hai artifact này.

| Artifact | Cột | Kiểu Arrow và ý nghĩa |
| --- | --- | --- |
| Cả hai | `capture_id`, `game_key` | string; UUID capture và `glowing_flower`/`free_drawing`. |
| Cả hai | `patient_id`, `session_id`, `trial_id` | int64; backend bổ sung patient/session từ capture đã xác thực. |
| Cả hai | `sequence` | int64; bắt đầu 0, liên tục và riêng cho stream event hoặc sample. |
| Cả hai | `timestamp_ms` | float64; timestamp monotonic trừ `t0` capture, đơn vị ms. Event là thời điểm xử lý/UI; sample là thời điểm nguồn đã được game sử dụng. |
| Cả hai | `source_timestamp_ms` | float64 nullable; thời điểm observation nguồn trừ cùng `t0`, tách biệt với thời điểm xử lý. |
| Cả hai | `source_observation_id` | int64 nullable; ID observation Phase 1 thực sự tạo đầu vào. Không dùng số frame nguồn để thay thế ID này. |
| Cả hai | `frame_id` | int64 nullable; chỉ cho ánh xạ chính xác được xác minh. Frontend Phase 2 để null, không ghép frame gần nhất. |
| Cả hai | `payload_json` | string; JSON của snapshot chuyển trạng thái hoặc mẫu tương tác. |
| Events | `event_id` | string; `{capture_id}:event:{sequence}`, giữ nguyên khi retry. |
| Events | `event_schema_version`, `event_type` | int64 = 1 và string tên chuyển trạng thái. |
| Samples | `sample_id` | string; `{capture_id}:sample:{sequence}`, giữ nguyên khi retry. |
| Samples | `sample_schema_version`, `sample_type` | int64 = 1 và string `flower_cursor`/`drawing_stroke_point`/`drawing_drag_point`. `hand_features` được schema dành chỗ nhưng chưa có bộ trích xuất tự động. |

`timestamp_ms` không được suy từ FPS hay upload. `source_observation_id` có thể ghép `frames.parquet` trong cùng capture để đọc raw landmarks; frame video mã hóa và observation không có quan hệ 1:1. Mốc MediaRecorder chỉ cho biết thời điểm sự kiện trình duyệt, chưa chứng minh đồng bộ pixel/PTS.

### Payload và sự kiện Hái hoa

| Event | Payload chính và ý nghĩa |
| --- | --- |
| `GAME_STARTED` | `score`, `gameplay_elapsed_ms`, `tracking_usable`, `side`; snapshot lúc gameplay bắt đầu. |
| `TARGET_SPAWNED` | `target_id=target-N`, `target_sequence`, `target_x/y`, `target_radius`, `radius_unit`, `coordinate_space`, `width/height`, `mapping_version`, `mapping`. Thời điểm spawn là timestamp của hàng event. |
| `TARGET_TOUCHED` | `target_id`, `cursor_x/y`, `score`; chỉ khi scoring thực sự tăng, một lần tăng điểm tương ứng một event. |
| `TARGET_RELEASE_GATE_CLEARED` | `target_id`, `cursor_x/y`; điều kiện rời vùng mục tiêu cũ vừa được giải phóng. Không phải thao tác giữ hoa. |
| `TRACKING_LOST`, `TRACKING_RECOVERED` | Target đang hoạt động và `freshness_ms`; chỉ phát khi trạng thái con trỏ đổi. |
| `GEOMETRY_PAUSED`, `GEOMETRY_RESUMED`, `GEOMETRY_CHANGED` | Snapshot target/mapping mới; dùng làm ranh giới đoạn quỹ đạo. `GEOMETRY_CHANGED` còn lưu thay đổi kích thước/ánh xạ không tạo trạng thái pause. |
| `GAME_COMPLETED`, `GAME_STOPPED`, `GAME_CANCELLED` | `reason`, `score`, `target_count`, `gameplay_elapsed_ms`; một trạng thái kết thúc phù hợp với lý do thực tế. |

`flower_cursor` lưu `x/y`, `target_id`, `side`, `usable`, `freshness` (`fresh`/`stale`/`missing`), `freshness_ms`, `geometry_paused`, `coordinate_space`, `width/height`, `mapping_version`, `representation=game_processed`. Chỉ có một mẫu cho observation Pose mới, không nhân mẫu theo RAF. Có thể có x/y null khi không dùng được; không biến mất tracking thành touch hoặc thất bại giả.

Tọa độ target/cursor thuộc `display_normalized`: x/y theo vùng hiển thị, không phải tọa độ camera raw. Đổi sang CSS px bằng `(x × width, y × height)` của chính snapshot; radius đã là CSS px. `mapping` lưu rect/box và mirrored; phiên bản hiện tại `video-mapping-v1`. Phải tách đoạn khi geometry/hệ/kích thước đổi, không so tọa độ từ hai snapshot trực tiếp.

### Payload và sự kiện Vẽ tự do

| Event | Payload chính và ý nghĩa |
| --- | --- |
| `GAME_STARTED` | `tracking_usable`, `drawing_mode`, `interaction_mode`, `cursor_source`, kích thước/hệ bảng vẽ. |
| `TOOL_CHANGED` | `previous`, `current`; thay đổi chế độ/công cụ/màu/độ rộng thực tế. |
| `PEN_DOWN`, `PEN_UP` | `reason`, `drawing_mode`; chuyển trạng thái bút, không phát mỗi observation. |
| `STROKE_STARTED` | `stroke_id` số tăng trong trial, `color`, `pen_width`, snapshot hệ/chế độ. |
| `STROKE_COMPLETED` | `stroke_id`, `reason`, `interrupted`, `point_count`; kết thúc nét kể cả khi hệ thống ngắt. |
| `STROKE_GRABBED` | `drag_id=drag-N`, `stroke_id`, `x/y`, `offset_x/y`, snapshot tọa độ/chế độ lúc cầm. |
| `STROKE_RELEASED`, `DRAG_INTERRUPTED` | `drag_id`, `stroke_id`, vị trí cuối `x/y`, offset cuối, `reason`, `interrupted`. |
| `UNDO` | Thao tác add/move được hoàn tác; ID nét và offset liên quan có trong payload. Lịch sử điểm gốc vẫn được giữ trong artifact. |
| `CLEAR_CANVAS` | ID các nét trước khi xóa; không xóa history đã ghi khỏi artifact. |
| `TRACKING_LOST`, `TRACKING_RECOVERED` | Chuyển trạng thái tay được game chấp nhận; `reason` nhận diện/freshness khi biết. |
| `GAME_PAUSED`, `GAME_RESUMED` | Pause/resume thực tế; resume không mặc định tracking đã sử dụng được. |
| `GEOMETRY_CHANGED` | Mapping/mirrored mới và snapshot tọa độ, dùng tách đoạn và giải thích ngắt nét. |
| `GAME_COMPLETED`, `GAME_CANCELLED` | Lý do kết thúc, số nét còn trên canvas, thời gian vẽ/elapsed snapshot của game; metrics lịch sử được tính riêng từ artifact. |

`PEN_UP`/kết thúc nét phân biệt `user_action`, `gesture_inactive`, `tracking_lost`, `geometry_changed`, `mode_changed`, `exercise_finished`, `drawing_limit`, `cursor_jump`, `cursor_outside_board`, `unknown` theo nguyên nhân thực tế. Khoảng chờ tay ngắn theo chính sách continuity hiện có có thể giữ nét mở, nhưng không chèn điểm cũ vào trajectory; mất tracking kéo dài kết thúc nét với interruption đúng lý do.

`drawing_stroke_point` lưu `stroke_id`, `x/y` đã được smoothing phục vụ game và được chấp nhận vào nét. `drawing_drag_point` lưu `drag_id`, `stroke_id`, vị trí cursor `x/y` và offset tuyệt đối `offset_x/y`; chỉ lưu khi vị trí nét thay đổi thực tế. Cả hai có `coordinate_space=logical_canvas_px`, kích thước logical canvas, `drawing_mode`, `cursor_source`, `representation=game_processed`, `usable`, `freshness`, `mapping_version=drawing-contain-v1`. Đơn vị là logical px, khác CSS px trên màn hình và khác mm/cm. Không sửa điểm stroke gốc sau khi kéo; áp offset riêng khi tái dựng.

Gesture mode dùng ngón trỏ; assisted mode dùng nút hạ/nhấc bút; move mode dùng chọn/cầm/thả hiện có. Không có pinch-to-draw/grab và chưa trích xuất pinch stability hay góc khớp trong Phase 2 này. Thiếu đặc trưng tay không được tự thay bằng giá trị 0.

### Metric envelope và chất lượng

Mỗi metric có `metric_name`, `value`, `unit`, `algorithm_version`, `sample_count`, `quality_status`, `unavailable_reason`. `sample_count` là số mẫu/đối tượng dùng trong phép tính, không mặc định là số video frame. `value=null` biểu thị không đủ dữ liệu hoặc chưa có thuật toán; 0 chỉ hợp lệ khi thực sự đo/đếm được bằng 0. Chi tiết tên thuật toán, tham số và công thức bên dưới phải đọc cùng phiên bản file JSON; không dùng điểm game làm FMA-UE.

File `game_metrics.json` gồm `metric_schema_version`, `algorithm_version`, `capture_id`, `trial_id`, `game_key`, `parameters`, `source_artifacts`, `source_artifact_checksums`, `trial`, `targets`, `strokes`, `drags`. Checksum source là SHA-256 của chính hai Parquet đã dùng. Không sửa raw landmarks và không nối quỹ đạo xuyên tracking loss, thay đổi geometry/hệ/kích thước hoặc khoảng mẫu quá lớn. Các metric về onset/reaction/movement time và smoothness hiện null với lý do chưa có thuật toán phù hợp; không dùng time-to-touch làm reaction time.

Phiên bản hiện tại là `metric_schema_version=1`, `algorithm_version=game-metrics-2d-v1`, `parameters.max_gap_ms=250`. Một cặp điểm chỉ hợp lệ khi cả hai usable/fresh, timestamp tăng với khoảng cách tối đa 250 ms, cùng hệ tọa độ, width/height và mapping version, không có chuyển trạng thái tracking/geometry/pause nằm giữa. Các event loss/recovery, geometry pause/resume/change và game pause/resume đều tách đoạn. Điểm không usable làm mất continuity. Không áp thêm bộ lọc lên raw; điểm drawing đã có smoothing của gameplay được nhận dạng bằng `game_processed`.

`quality_status=valid` nghĩa phép tính đủ điều kiện theo thuật toán này, không phải chứng nhận độ chính xác lâm sàng. `partial` nghĩa chỉ dùng được một phần quỹ đạo/lịch sử đã ghi, ví dụ có gap/cut, thay đổi hệ hoặc thiếu mốc kết thúc. `unavailable` đi với null và lý do. Path/speed cần ít nhất một cặp điểm hợp lệ; chỉ một điểm không đủ để gán chiều dài bằng 0. Một cặp đứng yên đo được mới có chiều dài/vận tốc 0 hợp lệ. Metric đếm bằng 0 hợp lệ khi đã có `GAME_STARTED` xác nhận khoảng thu, không suy 0 khi thiếu toàn bộ lịch sử.

### Công thức Hái hoa

Đặt `S` là timestamp spawn, `T` là timestamp touch hợp lệ, `Pᵢ` là cursor đã đổi sang CSS px, `N` là số target đã xuất hiện và `K` là số target có touch. Mục tiêu cuối chưa chạm vẫn nằm trong mẫu số; `success=false` chỉ nghĩa chưa hoàn thành trong dữ liệu, không xác định nguyên nhân người chơi hay tracking.

| Phạm vi / metric | Công thức và điều kiện | Đơn vị / lý do null chính |
| --- | --- | --- |
| Target `time_to_touch_ms` | `T − S`, chỉ khi có touch đúng target. Bao gồm thời gian wall-clock chờ tracking/geometry trong target đó. | ms; `target_not_touched`. |
| Target `movement_onset_ms`, `reaction_time_ms`, `movement_time_ms` | Chưa có thuật toán phát hiện khởi phát vận động được kiểm chứng; cả ba null. | ms; `movement_onset_algorithm_not_implemented`. |
| Target `path_length` | Tổng `‖Pᵢ − Pᵢ₋₁‖` của các cặp liên tục hợp lệ thuộc target. | px; `insufficient_contiguous_samples`. |
| Target `endpoint_error` | Khoảng cách từ cursor lúc touch đến tâm target trong cùng snapshot geometry và cùng CSS px. Nếu geometry đổi, dùng snapshot `GEOMETRY_*` mới nhất trước touch; JSON giữ riêng `target_geometry` lúc spawn và `touch_geometry` dùng tính lỗi. | px; `touch_coordinates_unavailable` khi không xác định được tọa độ tương thích. |
| Target `success` | Có đúng `TARGET_TOUCHED` cho target; không tạo touch giả do mất tracking. | boolean. |
| Target `tracking_loss_count` | Số chuyển `TRACKING_LOST` khi target hoạt động. | count. |
| Trial `spawned_target_count`, `completed_target_count` | `N` và `K`, đếm event spawn/touch đã xác minh. | count. |
| Trial `score` | Điểm trong event kết thúc game, đối chiếu số touch; sai khác được đánh partial. | count; `terminal_game_score_unavailable`. |
| Trial `completion_rate` | `K/N`; không gán 0 nếu chưa có target. | ratio 0..1; `no_spawned_targets`. |
| Trial `mean_time_to_touch_ms` | Trung bình `T − S` trên target đã touch. | ms; `no_touched_targets`. |
| Trial `total_path_length` | Tổng quỹ đạo cursor hợp lệ toàn trial; có thể nối qua hai target liên tiếp khi không có cut/gap/đổi geometry. | px; `insufficient_contiguous_samples`. |
| Trial `gameplay_duration_ms` | `gameplay_elapsed_ms` từ đồng hồ game trong event kết thúc, không tự suy từ wall-clock. | ms; `gameplay_clock_unavailable`. |
| Trial `wall_clock_duration_ms` | Timestamp terminal trừ timestamp `GAME_STARTED`. | ms; `missing_game_interval`. |
| Trial `tracking_loss_count` | Số chuyển `TRACKING_LOST` thực tế. | count. |
| Trial `tracking_coverage` | Tổng thời gian trạng thái tracking usable **và** không geometry/user pause, chia toàn wall-clock gameplay. Tích phân các khoảng trạng thái event; không đếm số RAF/frame. | ratio; `missing_game_interval_or_tracking_state` khi không biết toàn khoảng. |

### Công thức Vẽ tự do

Nét đã Undo/Clear vẫn tham gia lịch sử và metrics nghiên cứu; số nét cuối canvas trong kết quả game có thể khác `completed_stroke_count` nghiên cứu. `STROKE_COMPLETED` có thể là kết thúc chủ động hoặc ngắt hệ thống, cần đọc `stroke_interrupted` và lý do cùng số đếm. Đặt `t₀/tₙ` là timestamp nguồn của điểm đầu/cuối đã chấp nhận và `Δtᵢ` là khoảng giữa các cặp hợp lệ.

| Phạm vi / metric | Công thức và điều kiện | Đơn vị / lý do null chính |
| --- | --- | --- |
| Stroke `stroke_duration_ms` | `tₙ − t₀`; không dùng thời điểm upload hoặc độ trễ UI kết thúc nét. Một điểm cho duration 0 đã quan sát được; gap/cut hoặc thiếu completion đánh partial. | ms; `insufficient_data` khi không có điểm hợp lệ. |
| Stroke `stroke_point_count` | Số điểm quỹ đạo hợp lệ đã dùng cho nét; khác `point_count` completion thì partial, không gán 0 nếu thiếu toàn bộ samples đã chấp nhận. | count; `accepted_samples_unavailable`. |
| Stroke `stroke_length` | Tổng khoảng cách Euclid giữa các cặp hợp lệ cùng nét. | logical_canvas_px; `insufficient_contiguous_samples`. |
| Stroke `stroke_mean_speed` | `stroke_length / (ΣΔtᵢ / 1000)` trên cặp hợp lệ, không chia cho khoảng mất tracking. | logical_canvas_px/s; `insufficient_contiguous_samples`. |
| Stroke `stroke_smoothness` | Chưa có thuật toán được định nghĩa/kiểm chứng; null. | dimensionless; `smoothness_algorithm_not_implemented`. |
| Stroke `stroke_interrupted` | Cờ `interrupted` từ completion thực tế. | boolean; `stroke_completion_unavailable`. |
| Stroke `interruption_reason` | Lý do completion khi interrupted; `none` nếu kết thúc không gián đoạn. | category; `stroke_completion_unavailable`. |
| Drag `drag_duration_ms` | Timestamp processing release/interruption trừ timestamp grab. | ms; `drag_completion_unavailable`. |
| Drag `drag_distance` | Tổng khoảng cách quỹ đạo **offset của nét**, bắt đầu từ offset lúc grab; không lấy quãng đường cursor ngoài giới hạn làm quãng di chuyển nét. Chỉ cặp liên tục hợp lệ. | logical_canvas_px; `insufficient_contiguous_samples`. |
| Drag `drag_completed`, `drag_interrupted` | Release bình thường hoặc event interruption; khi chưa có terminal của drag thì null. | boolean; `drag_completion_unavailable`. |
| Drag `drag_interruption_reason` | Lý do interruption hoặc `none` khi release bình thường. | category; `drag_completion_unavailable`. |
| Trial `completed_stroke_count` | Số nét đã có completion, gồm nét bị hệ thống ngắt và nét sau đó bị Undo/Clear. | count. |
| Trial `active_drawing_duration_ms` | Tổng `ΣΔtᵢ` trên cặp điểm hợp lệ của mọi nét; loại khoảng thiếu dữ liệu. | ms; `insufficient_contiguous_samples`. |
| Trial `total_stroke_length` | Tổng chiều dài đo được trên mọi nét, không nhân đôi khi move. | logical_canvas_px; `insufficient_contiguous_samples`. |
| Trial `mean_stroke_duration_ms` | Trung bình duration đo được của nét có completion. | ms; `no_measured_completed_strokes`. |
| Trial `drag_attempt_count` | Số event grab. | count. |
| Trial `drag_completed_count`, `drag_interrupted_count` | Số thao tác có release bình thường hoặc interruption thực tế. | count. |
| Trial `undo_count`, `clear_count` | Số event Undo/Clear thực tế, kể cả thao tác trên canvas không đổi nếu UI cho phép. | count. |
| Trial `tracking_interrupted_stroke_count` | Số completion có `interrupted=true`, `reason=tracking_lost`. | count. |
| Trial `tracking_loss_count`, `tracking_coverage`, `wall_clock_duration_ms` | Cùng định nghĩa theo event như Hái hoa; tracking usable không đồng nghĩa bút đang hạ. | count, ratio, ms; lý do null như bảng Hái hoa. |

`sample_count` của duration/path/speed là số điểm hợp lệ; của giá trị nhị phân có thể là một đối tượng; của count/coverage có thể là số event nguồn hoặc số đối tượng dùng tính. Không so `sample_count` khác metric như cùng một loại mẫu. Không có chỉ số nào trong các bảng này là thước đo 3D, FMA-UE hoặc đánh giá mức phục hồi.

### Trạng thái artifact và retry

`artifact_summary`/manifest có trạng thái riêng `events_status`, `interaction_samples_status`, `game_metrics_status`, các trường `_file`, `_size_bytes`, `_sha256`, `event_count`, `interaction_sample_count`. Bản tóm tắt `game_metrics` là map metrics trial để báo cáo hiển thị. `not_requested` ở schema cũ không có nghĩa thiếu dữ liệu lỗi; schema 3 cần cả ba artifact mới được xác minh. Metrics chưa đủ dữ liệu có thể null dù artifact metrics đã được ghi complete.

`POST /api/captures/{capture_id}/game-batches` nhận `{batch_index,events,samples}` và `X-Chunk-SHA256` của byte JSON request. Frontend flush khi có 50 events hoặc 120 samples, hoặc timer 1 giây; server giới hạn 5 MiB/request, 256 events, 512 samples/batch, payload 64 KiB, độ sâu 8 và array 1.024 phần tử. Queue dùng chung giới hạn RAM tạm 8 MiB, IndexedDB 128 MiB/512 parts; không gửi request từng điểm.

Backend giữ `staging/game_batches/{index}.json` và `.sha256`. Retry cùng index/nội dung không tạo thêm hàng; khác nội dung bị từ chối. Finalize schema 3 kiểm tra `expected_game_batches`, `game_data_complete`, đủ batch liên tục, checksum, ID capture/trial/game, ID stream/sequence liên tục, timestamp trong duration, source observation tồn tại, liên kết chính xác khi khai báo frame và schema/count Parquet. History xác minh ID target/stroke/drag đã xuất hiện, không completion hai lần; capture tự khai báo đầy đủ phải có mốc game kết thúc. Giới hạn bảo vệ bộ nhớ gồm tổng 2.000.000 rows event+sample, tổng 100.000 đối tượng target/stroke/drag và tối đa 100.000 khoảng ID observation rời rạc trong index liên kết. Lỗi metrics không xóa video/raw/staging đã nhận. Lỗi mạng/quota phải được báo chưa hoàn chỉnh; phần chưa xác nhận được giữ lại theo cơ chế recovery Phase 1.
