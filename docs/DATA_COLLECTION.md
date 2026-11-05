# Thu thập dữ liệu nghiên cứu

Tài liệu này mô tả luồng thử nghiệm trong môi trường phát triển. Dùng dữ liệu giả danh, chỉ trên máy tin cậy và mạng localhost: ứng dụng chưa có xác thực và phân quyền để bảo vệ dữ liệu nghiên cứu thực tế. Video, landmark và metadata đều có thể chứa thông tin nhạy cảm; không đưa chúng vào Git, `frontend/public`, dịch vụ công khai hoặc log.

## Phase 1: tự động thu theo lượt chơi

Hái hoa (`glowing_flower`) và Vẽ tự do (`free_drawing`) dùng chung vòng đời capture trong Đánh giá và Luyện tập. Vẽ tự do chỉ được mở trong Đánh giá khi cấu hình danh mục cho phép `assessment` hoặc `both`; đây là hoạt động có lưu kết quả, không phải bài tự chấm FMA-UE. Game demo và replay độc lập không tự tạo trial lâm sàng hay auto-capture.

Nhân viên xác nhận riêng quyền thu landmark và video. Mặc định hai quyền đều chưa được xác nhận; thiếu một quyền thì game có thể tiếp tục theo chính sách hiện có nhưng giao diện phải báo không thu nghiên cứu. Quyền không được suy ra từ việc bật camera hoặc lưu hiệu chuẩn. Cấu hình auto-capture cố định là `both / actual / per_trial / continue`.

Khi nhấn bắt đầu, game tạo/lấy trial bằng `round_id` hiện có, rồi chuẩn bị capture `capture_mode=per_trial`, ghi video nguồn từ stream camera đang dùng và video tracking từ khung hình ghép lớp phủ tracking. Không mở camera hoặc model thứ hai. Việc chỉ chọn bài, setup camera hay xem kết quả không tạo auto-capture. Backend khóa trial và bảo đảm một auto-capture chính cho trial; capture thủ công cũ vẫn có thể có nhiều bản ghi cùng trial.

Mỗi lượt giữ đúng callback sở hữu capture của lượt đó, kể cả khi React render lại. Khi hết giờ, nhân viên dừng, điều kiện camera thay đổi hoặc component đóng, ứng dụng ghi mốc kết thúc gameplay và ngừng nhận observation mới, dừng recorder, nhận chunk cuối rồi flush/finalize. Upload có thể hoàn tất sau gameplay; thời điểm upload không phải thời điểm kết thúc vận động. Kết quả game có dữ liệu được gửi lưu tự động khi kết thúc lượt; nếu chưa xác nhận được lưu, nhân viên có thể thử lại với cùng mã lượt. Trial `cancelled` có thể có dữ liệu đã thu toàn vẹn; trial `completed` có thể có capture `incomplete`.

Capture của Phase 1 dùng `capture_schema_version=2`; Phase 2 bên dưới dùng schema 3 cho auto-capture mới. Metadata PostgreSQL và `manifest.json` lưu các ID, nguồn, quyền sử dụng, cấu hình nhiệm vụ, hiệu chuẩn/setup revision, ảnh hưởng bên, model/delegate, kích thước camera và MIME thực tế nếu biết. Phiên bản ứng dụng/commit hoặc thông tin chưa đo được có thể null; không suy ra FPS thực tế từ cấu hình danh nghĩa. Bản ghi cũ giữ schema và ý nghĩa lịch sử, không được tự bổ sung trạng thái Pose/Hand không thể xác định.

## Phase 2: sự kiện và quỹ đạo tương tác

Auto-capture schema 3 của `glowing_flower` và `free_drawing` mở rộng đúng uploader, queue, lease và thư mục UUID của Phase 1. Không tạo thêm camera, model hoặc inference; không thay đổi đồng ý thu video/landmark, luật chơi, điểm số hay việc lưu kết quả game. Capture thủ công và capture schema 1/2 lịch sử không bắt buộc có artifact Phase 2; việc thiếu chúng ở dữ liệu cũ không phải lỗi.

Ba artifact mới nằm cạnh video và Parquet Phase 1:

```text
REHAB_DATA_DIR/{capture_id}/
  events.parquet
  interaction_samples.parquet
  game_metrics.json
  manifest.json
```

`events.parquet` chứa chuyển trạng thái, `interaction_samples.parquet` chứa điểm game thực sự sử dụng; không nhân bản cả bộ landmark và không phát event mỗi render. `game_metrics.json` được backend tính từ hai Parquet đã đọc và xác minh, gồm metrics trial, target/stroke/drag, phiên bản thuật toán, tham số và checksum source artifact. PostgreSQL chỉ giữ metadata, trạng thái, đường dẫn/checksum và bản tóm tắt metrics trial trong `artifact_summary.game_metrics`; không lưu một hàng DB cho từng điểm.

**Hái hoa:** ghi `GAME_STARTED`, `TARGET_SPAWNED`, `TARGET_TOUCHED`, `TARGET_RELEASE_GATE_CLEARED`, `TRACKING_LOST`, `TRACKING_RECOVERED`, `GEOMETRY_PAUSED`, `GEOMETRY_RESUMED` và đúng một trạng thái kết thúc `GAME_COMPLETED`/`GAME_STOPPED`/`GAME_CANCELLED`. Event chỉ phát khi chuyển trạng thái tương ứng thực sự xảy ra; không có cơ chế giữ hoa. Mỗi lần tăng điểm khớp một `TARGET_TOUCHED`; target có ID `target-N` ổn định theo thứ tự xuất hiện. `flower_cursor` chỉ lưu khi có observation Pose mới, kể cả thông tin không usable; RAF lặp lại observation cũ không tạo điểm mới. Payload lưu target, bên tay, freshness, mapping và kích thước vùng. Tọa độ cursor/target được chuẩn hóa theo vùng hiển thị (`display_normalized`), bán kính là CSS px; phải nhân x/y với width/height trước khi tính khoảng cách px.

**Vẽ tự do:** ghi `GAME_STARTED`, `TOOL_CHANGED`, `PEN_DOWN`, `PEN_UP`, `STROKE_STARTED`, `STROKE_COMPLETED`, `STROKE_GRABBED`, `STROKE_RELEASED`, `DRAG_INTERRUPTED`, `UNDO`, `CLEAR_CANVAS`, `TRACKING_LOST`, `TRACKING_RECOVERED`, `GAME_PAUSED`, `GAME_RESUMED`, `GAME_COMPLETED`, `GAME_CANCELLED` theo chuyển trạng thái thực tế. Điểm được controller chấp nhận ghi thành `drawing_stroke_point`; kéo nét ghi thành `drawing_drag_point` riêng. Điểm đã qua xử lý game có `representation=game_processed`, không phải raw Hand. Undo/Clear được ghi trước khi xóa nét, nên lịch sử nét đã xóa vẫn nằm trong artifact. Di chuyển không sửa điểm gốc; tái dựng bằng offset riêng của thao tác kéo. Nguyên nhân kết thúc nét/kéo phân biệt `user_action`, `gesture_inactive`, `tracking_lost`, `geometry_changed`, `mode_changed`, `exercise_finished` và lý do khác có trong payload. Không coi pinch là điều khiển của game.

Event dùng thời điểm game xử lý hoặc UI tương tác; sample dùng thời điểm observation được chấp nhận. Cả hai trừ cùng `start_performance_ms=t0` của capture. `source_timestamp_ms` giữ riêng thời điểm observation khi khác thời điểm xử lý; `source_observation_id` chỉ gắn khi biết đúng nguồn. `frame_id` hiện để null, không lấy frame gần nhất. Có thể nối observation ID với `frames.parquet` và `landmarks.parquet` trong cùng capture; ID không khớp 1:1 với frame video mã hóa và không chứng minh đồng bộ pixel chính xác. Callback của lượt cũ giữ owner/scope riêng, không ghi sang lượt mới.

`POST /api/captures/{capture_id}/game-batches` nhận `{batch_index, events, samples}`; header `X-Chunk-SHA256` xác thực byte JSON request, sau đó backend lưu JSON chuẩn hóa và checksum staging riêng. Event/sample có ID ổn định `{capture_id}:event:{sequence}` và `{capture_id}:sample:{sequence}`, mỗi stream bắt đầu từ 0; retry dùng nguyên payload/index. Frontend flush khi có 50 events, 120 samples hoặc timer 1 giây; server giới hạn 5 MiB/request, 256 events/512 samples mỗi batch. Batch được lưu bền vững bằng IndexedDB và gửi cùng hàng đợi Phase 1, không gọi backend cho mỗi event. Queue dùng chung giới hạn tạm 8 MiB RAM, 128 MiB IndexedDB và 512 parts. Backend giữ `staging/game_batches/{index}.json` và `.sha256`; finalize cần `expected_game_batches` và trạng thái `game_data_complete`, kiểm tra đủ index, checksum, capture/trial/game, sequence liên tục, timestamp và schema/count Parquet, tối đa 2.000.000 rows event+sample. Metrics lỗi vẫn giữ video, raw landmarks, sự kiện và staging đã có; schema 3 chỉ complete khi mọi artifact bắt buộc đã xác minh và không có gap đã biết.

Lỗi mạng chỉ tạm dừng gửi, game và luồng lưu kết quả tiếp tục. Hết RAM/quota/giới hạn queue phải được báo incomplete, giữ phần chưa được xác nhận; không xóa phần cũ để báo complete. Metrics không đo được có `value=null` và lý do, không gán 0. Theo dõi mất tracking và thay đổi geometry để tách đoạn quỹ đạo; không cộng quãng đường/vận tốc xuyên khoảng mất dữ liệu hoặc trộn kích thước/hệ tọa độ. Công thức, đơn vị, quality và các metric chưa triển khai nằm trong [từ điển dữ liệu Phase 2](DATA_DICTIONARY.md#phase-2-game-events-interaction-samples-và-metrics).

Truy xuất theo bệnh nhân → session → trial bằng báo cáo hiện có, `GET /api/sessions/{session_id}/captures` hoặc `GET /api/trials/{trial_id}/captures`, rồi lấy metadata `GET /api/captures/{capture_id}`. Tải ba artifact qua `/api/captures/{capture_id}/artifacts/events`, `/interaction_samples`, `/game_metrics`; chỉ download khi trạng thái artifact tương ứng complete. Báo cáo từng lượt hiển thị chỉ số được xác minh; giá trị thiếu được ghi “Không đủ dữ liệu”, không đổi thành 0. CSV video-manifest lịch sử không đổi cột.

Ví dụ đọc lại cục bộ sau khi tải artifact, không tải dữ liệu lên dịch vụ ngoài:

```python
import json
from pathlib import Path
import pyarrow.parquet as pq

folder = Path(r"D:\private-research\capture-uuid")
def rows(name):
    with pq.ParquetFile(folder / name) as parquet:
        for batch in parquet.iter_batches(batch_size=512):
            for row in batch.to_pylist():
                yield {**row, "payload": json.loads(row["payload_json"])}

events = rows("events.parquet")
samples = rows("interaction_samples.parquet")
# Hai iterator giữ thứ tự sequence riêng đã được finalize kiểm tra.
# Đọc events để tạo index đối tượng, rồi đọc samples theo target/stroke/drag ID.
metrics = json.loads((folder / "game_metrics.json").read_text(encoding="utf-8"))
```

Để tái dựng, tạo target/nét từ event start/spawn; ghép điểm theo target/stroke/drag ID, giữ nguyên thứ tự timestamp/sequence và snapshot geometry. Áp dụng offset drag tại thời điểm tương ứng, rồi áp dụng Undo/Clear theo event; không chỉ đọc nét còn lại cuối trial. Đối chiếu checksum, schema và các quality flags trước phân tích. Quỹ đạo 2D hiển thị/bảng vẽ không phải phép đo 3D đã kiểm chứng; time-to-touch không phải reaction time thần kinh-vận động. Chưa có AI cá nhân hóa, chẩn đoán, tự chấm FMA-UE hoặc đánh giá hồi phục từ số nét/điểm game. Bằng chứng automated fixture/artifact phải được phân biệt với smoke clinical/replay và webcam thật; không coi code hoặc mock là bằng chứng gameplay ngoài thực tế.

## Nguồn và đồng ý

Có hai loại nguồn cần được phân biệt trong metadata: camera và video đã quay (`pre_recorded_video`). Video replay là dữ liệu đầu vào có sẵn, không chứng minh khả năng ghi webcam hay độ chính xác lâm sàng. Chỉ bắt đầu thu thập khi đã xác nhận riêng quyền thu landmark và quyền lưu video tương ứng. Video webcam là luồng camera không có overlay, được mã hóa theo định dạng do trình duyệt hỗ trợ; không gọi đó là dữ liệu cảm biến không nén.

Auto-capture mới khi đủ cả hai xác nhận còn ghi một video tracking riêng: hình camera có lớp phủ Pose/Hand theo dữ liệu hiển thị realtime. Video nguồn vẫn được lưu riêng, không bị thay thế. Video tracking có thể phản ánh kết quả hiển thị đã làm mượt và có độ trễ, không thay thế landmark raw trong Parquet; không giả định hai video hoặc landmark khớp chính xác từng frame. Capture cũ, capture thủ công và replay không tự có video tracking; xem trạng thái từng artifact thay vì suy đoán.

Video replay được chọn từ file cục bộ trong Tracking Test Lab. File gốc chỉ được đọc; không sửa, xóa, di chuyển, commit hoặc tự ý tải lên Internet. Khi kiểm thử, xem kỹ loại nguồn và điều kiện đồng ý trước khi lưu. Quy trình kiểm thử cụ thể và kết quả thực tế phải được phân biệt với kiểm thử giả lập; xem [danh sách kiểm thử](MANUAL_TEST_CHECKLIST.md).

Capture thủ công trong Camera & Calibration vẫn dùng các nút riêng: chọn phiên, bật camera và nhận diện, nhập ID trial hoặc để trống để tạo lượt mới, chọn dữ liệu và xác nhận quyền tương ứng rồi nhấn **Bắt đầu thu dữ liệu**. Nhấn **Dừng và lưu**, chờ chunk cuối, batch cuối và finalize; kiểm tra ID capture và thống kê trên màn hình. Hai game lâm sàng dùng vòng đời tự động ở trên. Trình duyệt có thể không hỗ trợ định dạng ghi phù hợp. Webcam thật phải được kiểm thử riêng; replay đọc video có sẵn không tự chứng minh MediaRecorder hoặc camera thật đã được kiểm thử.

## Liên kết và thời gian

Bệnh nhân, phiên và lượt tập liên kết dữ liệu qua `patient_id`, `session_id`, `trial_id`; `capture_id` nhận diện một lần thu. Dùng cả capture ID lẫn timestamp của từng frame để đối chiếu video với landmark. `frame_id` là thứ tự trong capture, không được dùng thay thế thời gian; `video_media_time_ms` là thời gian của frame trong nguồn video nếu có. Với replay, thời gian nguồn và đồng hồ chạy capture là những khái niệm khác nhau; cần xem metadata và phiên bản chương trình trước khi kết hợp. Thời gian video có thể khác đồng hồ capture, đặc biệt khi tải model, phát, tạm dừng, seek hoặc có độ trễ ghi. Không suy ra thời gian bằng frame ID chia FPS danh nghĩa và không khẳng định đồng bộ tuyệt đối nếu chưa đo sai số.

Một frame được quan sát nhưng không suy luận khác với frame đã suy luận mà không có detection. Theo dõi `inference_performed`, trạng thái phát hiện và số frame bỏ qua. Không suy ra landmark từ frame khác để lấp khoảng trống. Nếu replay bị seek hoặc phát lại, cần kết thúc hoặc reset trạng thái model và bắt đầu capture mới để không ghép các mốc thời gian sai.

Với auto-capture schema 2/3, main thread gán `source_observation_id`, thời điểm nguồn và scope capture trước khi gửi inference. Worker giữ nguyên các giá trị này; parallel ghép Pose/Hand theo đúng ID, scope và timestamp đầu vào, không theo thứ tự callback. Bộ ghép tối đa 120 observation chờ, hết hạn sau 2.000 ms khi có observation tiếp theo hoặc flush. Khi game kết thúc, có thể chờ tối đa 2.000 ms cho inference đã gửi thuộc đúng scope và thời điểm gameplay trước khi finalize; không nhận frame nguồn mới sau mốc dừng. Kết quả thiếu được ghi `missing_result`, không lấy landmark cũ bù vào. Callback từ scope cũ không được ghi vào lượt mới. Không đổi lịch inference, smoothing hay delegate để thu dữ liệu.

Mốc chung là `t0=performance.now()` trên main thread lúc bắt đầu capture; `timestamp_ms=source_observation_time_ms-t0`. UTC chỉ dùng đối chiếu hệ thống. `game_started_at_ms` và `game_ended_at_ms` là thời gian tương đối với cùng `t0`; `model_config_info.recorder_start` lưu riêng sự kiện recorder. `video_media_time_ms` là media time nguồn, **không phải PTS trong file MediaRecorder**. Manifest ghi `encoded_pts_mapping=unavailable`, `accuracy=approximate_unmeasured`: ID observation không tương ứng 1:1 với frame video đã mã hóa và chưa đo sai số đồng bộ.

Trong phiên bản hiện tại, với webcam và replay, `timestamp_ms` là thời điểm callback frame theo đồng hồ monotonic của trình duyệt trừ `start_performance_ms` của capture; UTC được suy ra từ `performance.timeOrigin` và callback, trước khi suy luận. Với replay, mốc capture được tạo trước khi gửi file, nên `timestamp_ms` có thể bao gồm thời gian gửi file trước khi video phát. `video_media_time_ms` lưu riêng thời gian media của frame; dùng trường này để đối chiếu vị trí trong video, không giả định nó bằng thời gian monotonic. Các capture cũ có thể dùng quy ước timestamp khác: xem phiên bản và metadata trước khi kết hợp dữ liệu. Những frame đếm là bỏ qua chỉ phản ánh callback bị giới hạn và khoảng trống trong bộ đếm trình duyệt có thể quan sát được; không thể phát hiện đầy đủ frame bị mất trước khi được trình bày. Sự kiện bắt đầu MediaRecorder được ghi trong `model_config_info.recorder_start` với `start_performance_ms`, `started_at_utc` và MIME thực tế; đối chiếu mốc này với `start_performance_ms` của capture để ước lượng độ lệch bắt đầu. Đây là mốc sự kiện trình duyệt, không chứng minh thời gian mã hóa hay timestamp pixel đầu tiên; sai số đồng bộ chưa được đo bằng thiết bị.

## Landmark và artifact

Raw là đầu ra model trước smoothing; display đã smoothing là dữ liệu hiển thị, không thay thế raw. Auto-capture nhận raw từ engine thực sự phục vụ game: main, worker hoặc parallel; không chạy thêm inference. Lưu toàn bộ 33 điểm Pose và 21 điểm của từng Hand khi model trả về, cả normalized-image và world nếu có. `normalized_image` không mặc định là cm hay mét; `world` là hệ tọa độ riêng của model. Visibility, presence, handedness và handedness score chỉ ghi khi API cung cấp. `hand_observation_index` chỉ phân biệt các tay trong một observation, không phải stable tracking ID xuyên video. Chính sách validity là số hữu hạn và x/y trong ảnh đối với normalized-image, không dùng ngưỡng visibility/presence để kết luận quan sát đúng. Điểm ngoài ảnh vẫn được lưu với lý do, không yêu cầu thấy chân/toàn thân. Xem [từ điển dữ liệu](DATA_DICTIONARY.md).

Dữ liệu lớn cần được chuyển theo batch với giới hạn bộ nhớ. Metadata thuộc PostgreSQL, còn video và artifact nằm trong vùng lưu trữ riêng của server được cấu hình bằng `REHAB_DATA_DIR`, không phục vụ qua static public. Lưu theo ID thay vì tên bệnh nhân. Staging phải được giữ khi upload hoặc chuyển đổi lỗi; chỉ coi capture hoàn chỉnh sau khi các artifact đã được ghi và xác minh. Khi kiểm tra hoàn tất, đối chiếu từng trạng thái, số lượng frame/landmark, kích thước và checksum; trạng thái metadata một mình không chứng minh file tồn tại hoặc còn nguyên vẹn.

## Cấu hình và kiểm tra artifact

Đặt `REHAB_DATA_DIR` thành đường dẫn riêng có quyền ghi và đủ dung lượng trước khi khởi động backend; đường dẫn tương đối được tính theo thư mục làm việc của tiến trình. Ví dụ môi trường phát triển trong `.env.example` dùng `./rehab-data`. Mỗi capture dùng thư mục UUID dưới gốc này; `staging/batches`, `staging/chunks` và `staging/tracking_chunks` giữ các phần đã nhận. File hoàn tất gồm `frames.parquet`, `landmarks.parquet`, `video` nguồn và, khi được yêu cầu, `tracking_video`, với phần mở rộng video theo MIME. Không sửa nội dung staging bằng tay. Không đặt gốc này trong `frontend/public` hoặc chia sẻ công khai.

Giao diện tạo capture rồi gửi batch và chunk tuần tự. Backend giới hạn batch 5 MiB và chunk 16 MiB; cùng index và cùng nội dung có thể gửi lại, nội dung khác bị từ chối. Mỗi batch landmark được chuẩn hóa rồi ghi cùng SHA-256; mỗi chunk video phải khớp checksum client gửi và được lưu checksum riêng. Finalize kiểm tra đủ các index đã khai báo và checksum staging trước khi chuyển batch sang Parquet theo từng batch, ghép chunk theo thứ tự, đối chiếu số dòng và tính SHA-256 artifact. Staging cũ không có checksum batch bị từ chối finalize; phải giữ lại để đánh giá riêng, không tự tạo checksum và khẳng định dữ liệu nguyên vẹn. Với webcam có ghi video, finalize yêu cầu metadata `recorder-start`; API chỉ nhận mốc này cho nguồn webcam và chấp nhận gửi lại cùng nội dung. Staging được giữ lại. Khi xử lý một phần thất bại, `artifact_summary` có trạng thái riêng `frames_status`, `landmarks_status`, `video_status`, `tracking_video_status`; capture chung có thể `incomplete` trong khi video nguồn đã hoàn tất. Việc kiểm tra checksum chứng minh tính toàn vẹn byte, không chứng minh video và landmark đồng bộ hay đúng về lâm sàng.

Capture mới có lease 120 giây theo đồng hồ PostgreSQL. Frontend gửi `POST /api/captures/{capture_id}/heartbeat` mỗi 30 giây trong lúc thu/finalize. Khi lease hết hạn, capture được đánh dấu `incomplete` khi kiểm tra và staging được giữ; việc hết hạn không phục hồi phần chưa gửi. Lỗi heartbeat/thu dữ liệu được báo riêng, không kết thúc gameplay. `lease_expires_at` là hạn vận hành, không phải mốc video; các capture cũ có thể không có lease. Không tự mở lại capture đã đóng hoặc suy đoán số batch/chunk để finalize.

Auto-capture ghi batch/chunk và metadata recorder vào IndexedDB `rehab-research-capture` (version 1, các store `captures`, `parts`, `usage`) trước khi gửi. Payload chỉ có UUID và dữ liệu đã được cho phép, không thêm tên bệnh nhân. Giới hạn mặc định toàn bộ phần đang chờ của origin là 128 MiB/512 phần; bộ đệm đầu vào mỗi uploader tối đa 8 MiB cộng tối đa 15 frame chưa thành batch. Các giới hạn được khai báo trong tùy chọn uploader; không giữ toàn bộ lượt trong RAM. Capture thủ công/replay tiếp tục dùng cơ chế tương thích cũ.

Mỗi phần tối đa ba lần gửi, backoff 250 ms rồi 1.000 ms; chỉ retry lỗi mạng, HTTP 408/429/5xx. Lỗi quyền/schema/checksum 4xx dừng retry phần đó. Cùng index/nội dung được gửi lại idempotent. Hết lượt retry thì tạm ngừng gửi, vẫn thu trong giới hạn hàng đợi; khi mạng trở lại có thể resume. Chỉ xóa phần local sau phản hồi server xác nhận. Đầy queue, lỗi IndexedDB/quota hoặc không thể lưu bền vững phải ghi nhận gián đoạn/`known_data_gaps`, báo `incomplete`, giữ phần chưa được xác nhận và để game tiếp tục; không âm thầm bỏ phần cũ để báo complete.

Sau refresh, recovery kiểm tra trạng thái và lease server trước khi gửi lại phần local. Chỉ capture đang `recording` với lease còn hợp lệ mới tiếp tục upload; finalize cần khai báo dừng thực sự đã lưu, gồm số phần và mốc thời gian. Nếu tab đóng trước khai báo dừng, phần recorder chưa phát chunk có thể mất: recovery không được coi IndexedDB là bằng chứng đủ video và phải báo incomplete. Capture hết lease/đã đóng giữ phần local chưa xác nhận và staging, không tự mở lại. Không tự xóa phần chưa xác nhận theo tuổi; dữ liệu được giữ có thể chiếm quota và cần người vận hành xử lý theo chính sách lưu giữ.

Mỗi auto-capture giữ Web Lock `rehab-research-capture:{capture_id}` từ trước khi tạo hàng đợi local đến khi dừng/finalize xong. Recovery cũng cần khóa độc quyền này; tab khác không được upload hoặc đánh dấu incomplete capture đang có chủ sở hữu. Trình duyệt tự giải phóng khóa khi tab đóng. Khi Web Locks không khả dụng hoặc khóa đang được giữ, không bắt đầu thu/khôi phục; game vẫn tiếp tục và UI báo nguyên nhân. Capture mới đã tạo trên server nhưng chưa ghi được dữ liệu sẽ hết lease theo quy tắc hiện có.

Snapshot nhiệm vụ Vẽ tự do lưu chế độ gesture/assisted, draw/move, nguồn con trỏ, màu/độ rộng bút và kích thước bảng vẽ khi bắt đầu. `configuration_scope=game_start_snapshot` phân biệt cấu hình đầu lượt với các thao tác thay đổi sau đó; Phase 1 chưa ghi chuỗi sự kiện thay đổi công cụ trong lượt.

Để xử lý capture hết lease khi đã biết chắc số lượng phần và mốc kết thúc, người vận hành có thể gửi `POST /api/captures/{capture_id}/recover-finalize` với `expected_batches`, `expected_video_chunks`, `ended_at_utc` và `duration_ms` theo đúng dữ liệu đã biết. Backend khóa capture, kiểm tra các phần và checksum rồi finalize mà không cấp lại lease; upload cũ không được tiếp tục. Nếu phần hoặc checksum thiếu/sai, API trả lỗi và giữ staging. Số lượng do người vận hành khai báo chỉ kiểm tra được các phần hiện có, không chứng minh phần chưa từng được gửi đã tồn tại; không tự suy đoán số lượng, thời lượng hay thời gian kết thúc để báo thành công. Capture `aborted` không thể recover qua endpoint này. Finalize đã hoàn tất có thể gửi lại cùng metadata; nếu khác, backend từ chối.

API capture chỉ dành cho localhost trong bản phát triển. Truy vấn `GET /api/captures/{capture_id}` để xem `artifact_summary`, trạng thái và lỗi; liệt kê bằng `GET /api/sessions/{session_id}/captures`. Tải artifact qua `GET /api/captures/{capture_id}/artifacts/video`, `/tracking_video`, `/frames`, `/landmarks` hoặc `/manifest`. File `complete` có thể được tải ngay cả khi capture chung `incomplete`; riêng video tracking `incomplete` cũng có thể tải nếu đã có file, nhưng phải xem đó là dữ liệu chưa hoàn chỉnh. CSV `GET /api/sessions/{session_id}/video-manifest` vẫn chỉ gồm capture complete và giữ các cột lịch sử.

Mỗi thư mục UUID có `manifest.json` mô tả ID/schema/nguồn, cấu hình, consent, mốc capture/game, lỗi/khoảng thiếu, giới hạn đồng bộ và từng artifact với tên, trạng thái, byte, SHA-256, số dòng khi áp dụng. `model_status_counts` và `missing_result_summary` thống kê trạng thái từng model cùng số observation thiếu, timestamp đầu/cuối khi xác định được. Checksum của chính manifest nằm trong `artifact_summary` PostgreSQL để tránh tự tham chiếu. Finalize chỉ complete sau đủ index/checksum, Parquet/video/manifest thành công, timeline hợp lệ và không có mất dữ liệu đã biết bị che giấu. File toàn vẹn không chứng minh tracking đúng hay đồng bộ đã kiểm chứng.

Kiểm tra một capture trên DB thử riêng: đọc lại `frames.parquet`/`landmarks.parquet` bằng `pyarrow.parquet.read_table`, đối chiếu schema, ID, số dòng, thứ tự thời gian, raw/world, Pose/Hand và các trạng thái thiếu; không chỉ xem HTTP 200. Tính `hashlib.sha256(path.read_bytes()).hexdigest()` cho từng file và đối chiếu manifest cùng `artifact_summary`; đọc video bằng OpenCV hoặc công cụ sẵn có, kiểm tra có frame giải mã được. Replay inference, camera giả có MediaRecorder và webcam thật phải được ghi là ba loại bằng chứng khác nhau. API `/docs` mô tả request/response thực tế; endpoint hiện chưa có xác thực/phân quyền cho dữ liệu bệnh nhân thật.

Capture Phase 1 lịch sử không sinh `events.parquet` hoặc trajectory riêng; các artifact này chỉ bắt đầu ở schema 3 của Phase 2. Reaction time, góc khớp, smoothness và AI chỉ định bài chưa được cung cấp khi chưa có thuật toán/kiểm chứng phù hợp.

## Phạm vi bảo mật và vận hành

Các endpoint tải dữ liệu trong bản phát triển không thay thế kiểm soát quyền truy cập. Trước sử dụng với người thật cần xác thực, phân quyền, bảo vệ dữ liệu khi lưu/truyền, quy trình consent, chính sách lưu giữ, giám sát và kiểm thử bảo mật. Không chạy công khai hoặc đưa dữ liệu thật vào hệ thống trước khi hoàn thành các điều kiện đó. Không tự động xóa dữ liệu đã nhận khi xử lý thất bại; kiểm tra trạng thái và bảo toàn staging trước khi khôi phục.

## Kết quả replay cục bộ 29-10-2026

Một phép thử Playwright trên Chrome dùng video MP4/H.264 1920 × 1080, 30.999.066 byte và PostgreSQL thử riêng. Pose và Hand đều chạy model MediaPipe cục bộ bằng CPU; không gọi `getUserMedia` hoặc tạo `MediaRecorder`, và trình duyệt chặn các kết nối ngoài localhost. Capture thử `f92d4542-baf4-4ae3-b23b-6316c1354cfe` có 113 frame được quan sát, trong đó 31 frame suy luận và 82 frame không suy luận; 27 frame có phát hiện Hand. Artifact chứa 5.262 landmark, gồm 4.272 raw, 990 display và 770 không hợp lệ. Có cả hệ `normalized_image` và `world`. Các frame được trình duyệt bỏ qua trước callback không có dữ liệu frame riêng; bộ đếm phụ thuộc thông tin trình duyệt cung cấp.

Video đã lưu có SHA-256 `707986329b852a7e4cfe38f954e01ccdd8e897479c5e0a4e1583a39956702273`, khớp video đầu vào và video tải lại. `frames.parquet` có 28.388 byte, SHA-256 `850bf2a5b7bcbb5deea426d8ecf488fd07b4b4ac506d4fc20b85aba21c33f677`; `landmarks.parquet` có 163.176 byte, SHA-256 `5ade75010e132e210cc9e23ce0605ea74834ea83fdfbe8b7f960613aba5f155a`. Thời gian media của các frame quan sát trong phép thử tăng từ 32,033 đến 13.520,633 ms. Đây là capture tạo trước thay đổi quy ước `timestamp_ms` replay hiện tại, là kết quả của một lần chạy, không phải đánh giá độ chính xác nhận diện hay độ lệch đồng bộ và không chứng minh ghi webcam thật.

Một lần chạy lại sau khi tách đồng hồ, capture `112d1508-ecbd-4721-af30-b9f560d3785a`, có 115 frame quan sát, 22 frame suy luận, 18 frame phát hiện Hand và 3.615 landmark (3.075 hợp lệ, 540 không hợp lệ). Video 30.999.066 byte có cùng SHA-256 như trên; `frames.parquet` 28.309 byte có SHA-256 `2d1339276ea3fc4d329a073f9ecefbde4313d2dc77149e297e844829dfcd41f4`; `landmarks.parquet` 120.274 byte có SHA-256 `1725a3d2528f0a572027ad556bfe86764c90ae78e9d5cb99a0e4208ce656d1c2`. `timestamp_ms` nằm trong khoảng 11.574,8–25.263,3 ms do mốc capture bắt đầu trước khi upload video; media time là 0–13.648,667 ms. Kiểm thử tự động đọc Parquet để đối chiếu schema, ID, thời gian, Pose/Hand, raw/display, world và validity. Metadata của riêng capture này vẫn có nhãn `timestamp: video_media_time` cũ; giá trị `timestamp_ms` thực tế theo đồng hồ capture, và nhãn mã nguồn đã được sửa cho capture tiếp theo.

Sau khi sửa nhãn metadata, capture `7f5feed1-0190-4ee4-9b3a-003be5e795a6` cũng vượt qua kiểm thử Playwright và verifier Parquet: 121 frame quan sát, 34 suy luận, 5.895 landmark (5.047 hợp lệ, 848 không hợp lệ). Video có cùng SHA-256 với bản gốc. `frames.parquet` 31.358 byte có SHA-256 `e0ec3afc1079bb7c106cf010957a0558ca5decca10077e106b9787ff9b314e80`; `landmarks.parquet` 182.199 byte có SHA-256 `b868ec17c81a89eb39090783ede2b1dfadce6e982221a701dd1e8f79b68189ff`. Metadata của capture này xác nhận `capture_relative_monotonic_callback` và `video_media_time` là hai mốc riêng.

Một kiểm thử Playwright khác dùng camera giả của Chrome, capture `3593730c-8ac3-458d-a836-69789b485560`, đã ghi hai chunk gồm chunk cuối và tải lại 131.149 byte. SHA-256 tải về `3e045874fae0e0f9c5148d175d3c7cc2222ff83a65c8469245e8b59e4e6f13ea` khớp các chunk MediaRecorder. Kiểm thử xác nhận recorder dùng trực tiếp stream camera không có audio và không gọi `canvas.captureStream()`. Ảnh giả không chứa người: 15 frame quan sát, 4 frame suy luận và không có landmark. Kết quả này không thay thế kiểm thử webcam thật.

## Bằng chứng Phase 1 — 04-11-2026

Baseline đã xác minh: `origin/main`, commit `0821f7dedeefadf233db6f2ede36eab961b1405e` (đã merge Hand-First GPU và Vẽ tự do). Nhánh triển khai: `feat/research-capture-phase1`; HEAD vẫn ở baseline, chưa commit/push/merge/deploy. Tại thời điểm kiểm thử này, migration `d32f_research_capture_phase1` được áp dụng trên PostgreSQL test riêng, cổng 55439. Kiểm tra nâng từ `c21` giữ nguyên hai capture lịch sử của cùng trial ở `manual/schema1`. Sau đó migration đã được áp dụng cho DB ứng dụng; số hồ sơ, buổi, lượt và kết quả không thay đổi.

Các kiểm tra đã chạy có mục tiêu, không chạy full suite/coverage và không tạo lại E2E:

- Frontend `npm run build`: PASS, còn cảnh báo kích thước bundle và import MediaPipe chung chunk.
- `npx vitest run src/features/workspace/captureOwnership.test.ts src/features/workspace/captureUploader.test.ts src/features/workspace/useResearchCapture.test.tsx`: 43 PASS sau sửa khóa giữa các tab, hủy lúc chuẩn bị và cutoff thời gian.
- Các target game/config, trang/workflow và UI artifact tương ứng: 34 + 13 + 14 + 10 PASS; các target tracking/collector đã xác minh trước đó: 80 PASS. Các nhóm này có thể giao nhau, không dùng tổng làm số test độc lập hoặc coverage.
- Backend `pytest tests/test_capture_api.py tests/test_capture_storage.py tests/test_capture_finalize.py tests/test_free_drawing.py -q`: 34 PASS trên DB riêng; đọc Parquet/checksum thực tế, idempotency, schema, liên kết trial, finalize và assessment Free Drawing. `/api/health` của API test trả `status=ok`, `database=connected`.
- `git diff --check` sạch; CodeGraph sync/status hoạt động. Không cài framework hoặc dependency mới.

Smoke dùng Chrome 156 và bản build tĩnh, mở đúng UI clinical Đánh giá/Luyện tập, không dùng Tracking Test Lab. Nguồn chỉ đọc: `video_test/WIN_20261103_22_45_01_Pro.mp4`, SHA-256 `08aab59258af231aaaab7df84c3e6d7b9dd145a98eaa3de64491dd7b8ad9e881`. Trình kiểm thử chuyển hình từ video vào camera giả 1920×1080; recorder sản phẩm nhận track video nguồn đó, không audio. Worker hiện có chạy Pose Lite/Hand với delegate CPU do trình kiểm thử đặt; mã sản phẩm vẫn giữ ưu tiên GPU. Các lần thử GPU headless bị timeout, không được tính là PASS GPU.

| Quy trình / game | Capture mẫu | Frame / landmark raw | World | Frame video giải mã |
|---|---|---:|---:|---:|
| Luyện tập / Hái hoa | `266d48b7-3025-4477-b66d-133dcfcfded1` | 66 / 864 | 432 | 96 |
| Luyện tập / Vẽ tự do | `9e14633c-9473-4a7a-9aee-a1697ffb8773` | 102 / 1728 | 864 | 128 |
| Đánh giá / Hái hoa | `168abd16-2c3c-4ae5-8b5b-02707790c8ce` | 53 / 540 | 270 | 75 |
| Đánh giá / Vẽ tự do | `24edb9e6-d118-468d-a4bf-d154760d7776` | 121 / 1620 | 810 | 141 |

Cả bốn capture có trạng thái artifact complete. Verifier đọc lại Parquet, kiểm tra ID/cặp timestamp, source observation duy nhất, thứ tự thời gian nằm trong mốc gameplay, trạng thái từng model, nhóm raw/world đủ 33/21 điểm, handedness score và checksum/kích thước từng artifact cùng checksum manifest. OpenCV giải mã được video 1920×1080. Các frame quan sát và frame video không có tương ứng 1:1.

Trong lượt Vẽ tự do Luyện tập, trình kiểm thử làm lỗi mạng upload: game vẫn chạy, IndexedDB thực giữ 6 phần/637.375 byte sau ba lần gửi lỗi; nối lại rồi finalize xong, hàng đợi về 0 phần/0 byte. Browser xác nhận Web Locks khả dụng và có khóa capture đang được giữ; contention/recovery giữa các tab được kiểm tra bằng test có mục tiêu.

**Giới hạn bằng chứng Phase 1 lịch sử:** cả bốn lượt smoke chưa lưu kết quả game qua UI; giao diện không cho lưu trong điều kiện đầu vào/thời gian đáp ứng của lần thử, nên trình kiểm thử hủy trial thay vì tạo kết quả giả. Capture của đoạn đã thu vẫn được giữ và xác minh. Lưu kết quả game được kiểm tra bằng unit/integration riêng, chưa có bằng chứng smoke thành công cho toàn bộ chuỗi chơi → lưu kết quả → tiếp tục cùng session. Chưa kiểm thử webcam thật, GPU headless thành công hoặc đo sai số đồng bộ encoded PTS. Capture complete chỉ nói về artifact đã khai báo, không chứng minh chất lượng tracking/lâm sàng. Các bằng chứng ngày 04-11 này không kiểm tra artifact Phase 2.

Artifact và bằng chứng máy cục bộ nằm ngoài Git ở `%TEMP%/rehab-phase1-smoke/data/{capture_id}/` và các tệp `report.json`, `artifact-verification.json`, `video-decoding.json` cùng thư mục. Không đưa video, landmark hoặc browser profile vào repository.

Phạm vi file thay đổi của Phase 1 (48 file, gồm test và tài liệu; không gồm các mục untracked có sẵn của người dùng):

```text
backend/alembic/versions/d32f_research_capture_phase1.py
backend/app/capture_manifest.py
backend/app/capture_schemas.py
backend/app/capture_storage.py
backend/app/captures.py
backend/app/main.py
backend/app/models.py
backend/app/workflow_common.py
backend/tests/test_capture_api.py
backend/tests/test_capture_storage.py
backend/tests/test_free_drawing.py
docs/DATA_COLLECTION.md
docs/DATA_DICTIONARY.md
frontend/public/tracking-worker.js
frontend/src/components/CaptureArtifacts.test.tsx
frontend/src/components/CaptureArtifacts.tsx
frontend/src/features/rehab/ClinicalWorkspace.test.tsx
frontend/src/features/rehab/ClinicalWorkspace.tsx
frontend/src/features/rehab/ExerciseCatalog.tsx
frontend/src/features/rehab/GameResult.test.tsx
frontend/src/features/rehab/GameResult.tsx
frontend/src/features/workspace/captureLandmarks.test.ts
frontend/src/features/workspace/captureLandmarks.ts
frontend/src/features/workspace/captureObservations.test.ts
frontend/src/features/workspace/captureObservations.ts
frontend/src/features/workspace/captureOwnership.test.ts
frontend/src/features/workspace/captureOwnership.ts
frontend/src/features/workspace/captureQueueStore.ts
frontend/src/features/workspace/captureUploader.test.ts
frontend/src/features/workspace/captureUploader.ts
frontend/src/features/workspace/gameWorkflow.ts
frontend/src/features/workspace/handFirstWorker.test.ts
frontend/src/features/workspace/parallelWorkerTracker.test.ts
frontend/src/features/workspace/parallelWorkerTracker.ts
frontend/src/features/workspace/trialResearchCapture.test.ts
frontend/src/features/workspace/trialResearchCapture.ts
frontend/src/features/workspace/useFlowerGame.tsx
frontend/src/features/workspace/useFlowerGameWorkflow.test.tsx
frontend/src/features/workspace/useFreeDrawingGame.test.tsx
frontend/src/features/workspace/useFreeDrawingGame.tsx
frontend/src/features/workspace/useResearchCapture.test.tsx
frontend/src/features/workspace/useResearchCapture.ts
frontend/src/features/workspace/workerTracker.ts
frontend/src/features/workspace/WorkspaceHandFirst.test.tsx
frontend/src/features/workspace/WorkspacePage.tsx
frontend/src/features/workspace/WorkspaceWorkflow.test.tsx
frontend/src/pages/Assessment.test.tsx
frontend/src/types/rehab.ts
```

## Bằng chứng Phase 2 — 05-11-2026

Nhánh `feat/research-capture-phase2`, base/HEAD `f2756d2a7eecea99a0c75ba6da46bb65025bf764`; Phase 1 đã có trong nhánh nền. Các thay đổi Phase 2 còn trong working tree, không commit, push, merge hoặc deploy. Không cần migration mới; schema 3 dùng cột version và JSON metadata sẵn có, dữ liệu schema 2 được kiểm tra tương thích bằng test riêng.

Các kiểm tra có mục tiêu đã xác minh:

- Backend: 48 test capture/API/storage/finalize PASS trên PostgreSQL riêng `127.0.0.1:55432`, DB `rehab_phase2_tests`; không dùng DB ứng dụng để ghi fixture.
- Metrics: 8 test PASS, gồm đọc lại Parquet và JSON metrics thực tế, đối chiếu SHA-256, metric thiếu mẫu trả null, trajectory có gap và geometry thay đổi. Đây là fixture xác định, không phải bằng chứng đo chuyển động thật.
- Frontend: 206/206 test PASS trong 12 file instrumentation/workflow/uploader/capture/report; [kết quả JSON cục bộ](C:/Users/nnam05/AppData/Local/Temp/phase2-final-tests.json). `npm run build` PASS. Còn cảnh báo bundle lớn và MediaPipe được import cả tĩnh/động; không dùng build làm bằng chứng tracking/FPS thực tế.
- API test tại cổng `58001`: `/api/health` trả `status=ok`, `database=connected`.

Các target frontend có thể chạy lại từ `frontend/` bằng lệnh sau; không chạy full suite/coverage hoặc tạo E2E mới:

```powershell
npm test -- --run src/components/CaptureArtifacts.test.tsx src/features/workspace/captureUploader.test.ts src/features/workspace/flowerResearch.test.ts src/features/workspace/freeDrawing.test.ts src/features/workspace/gameResearch.test.ts src/features/workspace/trialResearchCapture.test.ts src/features/workspace/useFlowerGame.test.tsx src/features/workspace/useFlowerGameWorkflow.test.tsx src/features/workspace/useFreeDrawingGame.test.tsx src/features/workspace/useResearchCapture.test.tsx src/features/workspace/WorkspaceHandFirst.test.tsx src/features/workspace/WorkspaceWorkflow.test.tsx
npm run build
```

Backend chạy từ `backend/`, với `TEST_DATABASE_URL` trong môi trường tiến trình con trỏ đúng DB test riêng ở cổng `55432` (không trỏ DB ứng dụng). Bốn file capture dưới đây cho 48 PASS; metrics chạy riêng cho 8 PASS:

```powershell
.venv/Scripts/python.exe -m pytest tests/test_capture_game_storage.py tests/test_capture_storage.py tests/test_capture_finalize.py tests/test_capture_api.py -q
.venv/Scripts/python.exe -m pytest tests/test_game_metrics.py -q
```

Phạm vi file Phase 2, gồm các test có mục tiêu đi kèm từng nhóm:

| Nhóm | File/module thay đổi |
| --- | --- |
| Capture/backend và toàn vẹn artifact | `backend/app/capture_schemas.py`, `capture_manifest.py`, `captures.py`; mới `capture_game_storage.py`; `backend/tests/test_capture_api.py`, `test_capture_finalize.py`, mới `test_capture_game_storage.py`. |
| Tính metrics | Mới `backend/app/game_metrics.py`, `backend/tests/test_game_metrics.py`. |
| Clock, owner/scope và uploader | `frontend/src/features/workspace/gameWorkflow.ts`, `gameResearch.ts` mới, `trialResearchCapture.ts`, `useResearchCapture.ts`, `captureUploader.ts`, `captureQueueStore.ts`, `WorkspacePage.tsx` và test liên quan. |
| Hái hoa | `frontend/src/features/workspace/useFlowerGame.tsx`, `flowerResearch.ts` mới và test; không đổi thuật toán scoring trong `flowerGame.ts`. |
| Vẽ tự do | `frontend/src/features/workspace/freeDrawing.ts`, `freeDrawingHand.ts`, `useFreeDrawingGame.tsx` và test. |
| Báo cáo | `frontend/src/components/CaptureArtifacts.tsx` và test, `frontend/src/features/workspace/CaptureArtifactStatus.tsx`, `frontend/src/types/rehab.ts`. |
| Tài liệu | `docs/DATA_COLLECTION.md`, `docs/DATA_DICTIONARY.md`; không có migration mới. |

Các mục untracked có sẵn `.codegraph/`, `codegraph.json`, `ketqua/`, `video-game-mau/` không bị xóa hoặc đưa vào phạm vi tính năng. `.codegraph/` được sync theo yêu cầu; dữ liệu có sẵn trong `ketqua/` và `video-game-mau/` được bảo toàn.

Artifact fixture backend được giữ ngoài Git trong thư mục cục bộ `C:\Users\nnam05\AppData\Local\Temp\rehab-phase2-backend-final-ca5f9ac964054a93b96890a56841a52d\`:

| Fixture / thư mục tương đối | Events / samples | Nội dung đã đọc lại |
| --- | ---: | --- |
| Hái hoa — `test_phase2_upload_retry_final0/26f79d75-1560-485c-b361-aa3462e3b34a/` | 4 / 2 | Events, cursor samples, metrics, manifest và checksum; retry không tạo thêm hàng. [Manifest cục bộ](C:/Users/nnam05/AppData/Local/Temp/rehab-phase2-backend-final-ca5f9ac964054a93b96890a56841a52d/test_phase2_upload_retry_final0/26f79d75-1560-485c-b361-aa3462e3b34a/manifest.json). |
| Vẽ tự do — `test_phase2_drawing_deleted_st0/6237fc3d-47ed-46e4-9c81-d526ff9e13e1/` | 8 / 4 | Điểm nét gốc, drag offset, Undo/Clear, metrics, manifest và checksum; lịch sử còn sau khi xóa canvas. [Manifest cục bộ](C:/Users/nnam05/AppData/Local/Temp/rehab-phase2-backend-final-ca5f9ac964054a93b96890a56841a52d/test_phase2_drawing_deleted_st0/6237fc3d-47ed-46e4-9c81-d526ff9e13e1/manifest.json). |

Hai fixture có `video.mp4` 47 byte tổng hợp cho kiểm thử luồng lưu trữ, **không phải video container hợp lệ**. Các test này chứng minh artifact game/Parquet/JSON và checksum đã ghi/đọc được; không chứng minh video giải mã được, gameplay ngoài thực tế, webcam, GPU hay hiệu năng.

**Smoke clinical hai lượt: NOT VERIFIED.** Đã mở route Luyện tập thực `/training/1`, dùng dữ liệu giả lập và nguồn MP4 chỉ đọc `video_test/WIN_20261103_22_45_01_Pro.mp4` qua `HTMLVideoElement.captureStream()`/camera shim trong Chrome headless. Video nguồn 72.603.513 byte, SHA-256 `08aab59258af231aaaab7df84c3e6d7b9dd145a98eaa3de64491dd7b8ad9e881`, không chỉnh sửa hoặc gửi lên dịch vụ ngoài. Dashboard tải dữ liệu API, tạo session số 1 qua UI và phát được stream camera từ video, nhưng Worker báo `Worker inference timed out` và `Worker disposal timed out; model cleanup was not acknowledged`. Thử Edge headless bổ sung không giữ được kết nối browser; không thay delegate, FPS hoặc pipeline để ép qua bước này.

DB smoke riêng `rehab_phase2_smoke` còn một session `draft`, setup chưa xác nhận, **0 trial, 0 game result, 0 capture**. Chưa thực hiện được hoàn thành game → lưu game result → xem kết quả → tiếp tục game khác trong cùng session; không tạo kết quả giả và không tính smoke PASS. Bằng chứng: [clinical-smoke.json](C:/Users/nnam05/AppData/Local/Temp/rehab-phase2-smoke-f74b43f032ed40d6a829a5ed3a984d50/clinical-smoke.json) và [setup.png](C:/Users/nnam05/AppData/Local/Temp/rehab-phase2-smoke-f74b43f032ed40d6a829a5ed3a984d50/setup.png). Đây không phải webcam thật hoặc đo hiệu năng.

Các dịch vụ do lượt kiểm tra này khởi tạo đã được dừng, gồm PostgreSQL test cổng `55432`; PostgreSQL có sẵn của người dùng cổng `5432` giữ nguyên. Chưa có bằng chứng định lượng về ảnh hưởng FPS/độ trễ gameplay, đồng bộ encoded PTS hoặc độ chính xác lâm sàng. AI cá nhân hóa, onset/reaction/smoothness cần thuật toán được kiểm chứng và các phân tích AI khác vẫn là phần việc sau Phase 2.
