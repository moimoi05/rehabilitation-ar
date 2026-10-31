# Tracking benchmark

> **Lưu ý:** Toàn bộ thư mục `e2e/` chứa các harness và probe benchmark (như `tracking-baseline.cjs`, `tracking-worker-probe.cjs`...) đã được xóa hoàn toàn để tinh giản codebase. Tài liệu này được giữ lại làm dữ liệu lịch sử tham khảo hiệu năng.

## Điều kiện và phương pháp

Các lần đo ngày 28-10-2026 dùng video do người dùng cung cấp, nạp trực tiếp qua file picker vào Chromium headless 156, trên Windows 11, CPU Intel Core i5-1340P và Intel Iris Xe. File gốc truy cập được; metadata do trình duyệt đọc là **1920 × 1080, 13,739959 giây**. Không sao chép, upload hoặc ghi video vào database. Không xác định được frame rate mã hóa chính xác bằng công cụ hiện có.

Harness `e2e/tracking-baseline.cjs` tái hiện riêng logic cũ: Pose Landmarker Lite, `VIDEO`, một pose, CPU, `requestAnimationFrame`, chỉ chạy khi `currentTime` thay đổi và ít nhất 100 ms từ lần chạy trước. Ba giây đầu dùng warm-up, sau đó đo phần còn lại của video. Đo lặp lại; máy có thể còn tác vụ nền. Một cặp baseline và optimized được chạy liền kề; sau đó chạy lặp lại optimized. Scheduler optimized lần cuối có SHA-256 `BBCD7BB1AE95C54DBF5406756416D554D04BE1847E19EB681CC8FBC672A38F68`. Mô hình và WASM là tài sản cục bộ của ứng dụng. Harness không chạy toàn bộ giao diện, canvas ghost hoặc trò chơi, do đó tốc độ rAF trong bảng **không phải** FPS render ứng dụng. MediaPipe inference đồng bộ làm gián đoạn cả rAF lẫn video callbacks trên main thread.

| Chỉ số | Baseline liền kề | Scheduler mới lần 1 | Scheduler mới lần 2 |
| --- | ---: | ---: | ---: |
| Thời gian đo | 10,861 s | 10,767 s | 10,756 s |
| Số lần inference | 92 | 65 | 73 |
| Inference FPS | 8,47 | 6,04 | 6,79 |
| Trung bình inference | 110,62 ms | 111,58 ms | 105,74 ms |
| p50 / p95 inference | 103,80 / 159,60 ms | 98,90 / 164,70 ms | 104,20 / 137,00 ms |
| Frame inference có pose | 92/92 | 65/65 | 73/73 |
| Callback video quan sát | 100 | 186 | 169 |
| Chênh lệch `presentedFrames` | 312 | 314 | 314 |
| rAF của harness | 14,46/s | 37,61/s | 34,31/s |
| Callback bị scheduler giới hạn | 65 | 121 | 96 |
| Long tasks quan sát (thời gian đo) | 92 | 65 | 74 |

Hai lần baseline ban đầu trên một harness tương đương cho 8,33 và 8,26 inference/s, p95 156,70 và 149,30 ms. Scheduler mới chạy `requestVideoFrameCallback`, adaptive cap Balanced 24 FPS và cùng Pose Lite CPU. Bảng đo scheduler riêng, không bao gồm smoothing hoặc công việc UI ứng dụng. Lần optimized đầu có thể trùng lúc scheduler còn được sửa; hash trên chỉ xác nhận phiên bản lần cuối. Tại cấu hình này scheduler mới nhường thời gian cho rAF nhưng inference FPS giảm. p95 biến thiên từ 137 đến 164,7 ms nên chưa đủ bằng chứng khẳng định p95 cải thiện; rAF harness tăng cũng không chứng minh render thực tế hay chất lượng theo dõi tốt hơn. Callback bị giới hạn của baseline tính trên rAF, còn optimized tính trên video callback, nên không so trực tiếp hai số này. Các long task là sự kiện PerformanceObserver, có thể bỏ sót sự kiện chưa được phân phối vào cuối cửa sổ đo.

Các lượt trên được đo trước lần sửa scheduler dùng `presentedFrames` cho nguồn có `mediaTime` không đổi; chúng không xác nhận hiệu năng phiên bản scheduler sau sửa.

Chênh lệch `presentedFrames` tương ứng xấp xỉ 28,7–29,2 frame/s trong khoảng đo, nhưng đây là chỉ số trình duyệt báo, không phải phép đo chính xác FPS mã hóa hoặc số frame được giải mã và không cho phép quy tất cả callback không quan sát được thành frame bị rơi. Kiểm tra `currentTime` trùng trên rAF không xảy ra ở hai lần này; không có inference trùng trong harness. Tỷ lệ có pose chỉ cho biết có kết quả, **không phải độ chính xác tuyệt đối**. Không có ground truth nên chưa thể định lượng chính xác, jitter, độ bám, độ trễ bổ sung bởi smoothing, tuổi kết quả, thời gian overlay, hoặc mức thay đổi CPU/GPU/RAM. Long-task chỉ mang tính thăm dò do cửa sổ ngắn và không đại diện toàn ứng dụng.

Headless là công cụ so sánh tương đối trong cùng điều kiện, không đại diện chắc chắn hiệu năng GPU hoặc webcam thực. So sánh tối ưu cần cùng video, browser, delegate, model, độ phân giải, thời gian warm-up, khối lượng overlay và các tác vụ nền; không so sánh kết quả GPU với CPU như thể chỉ thay scheduler. Các mục tiêu FPS và p95 là mục tiêu tham khảo, không phải cam kết thiết bị.

## Chạy lại baseline

Trong `frontend`, chạy `npm run dev` trên cổng 5173; trong thư mục `e2e`, chạy `node tracking-baseline.cjs "<đường dẫn video cục bộ>" baseline` hoặc `node tracking-baseline.cjs "<đường dẫn video cục bộ>" optimized`. Có thể đặt `TRACKING_BENCH_URL` nếu Vite dùng cổng khác, và `TRACKING_BENCH_CHANNEL` để chọn browser channel Playwright. Video được đọc qua file input trong browser, không được đưa vào thư mục public. Script xuất JSON chỉ gồm metadata và thống kê, không xuất landmark hoặc nội dung video. Không dùng giá trị này làm benchmark của UI thực; chế độ optimized import trực tiếp scheduler hiện tại từ Vite và giữ model CPU, không đo smoothing/overlay.

## Thử nghiệm Dedicated Worker độc lập

Dùng cùng video gốc, browser và Pose Lite VIDEO; không đưa Worker này vào phép đo UI hoặc khẳng định cấu hình đã tích hợp sản phẩm. Prototype `e2e/tracking-worker-probe.cjs` dùng classic Worker, `ImageBitmap` chuyển quyền sở hữu, tối đa một frame đang xử lý, đóng bitmap trong Worker; scheduler thử nghiệm có giới hạn thích ứng riêng. Sau 3 giây warm-up:

| Chỉ số | Worker CPU classic | Worker GPU classic |
| --- | ---: | ---: |
| Khoảng đo / số kết quả | 10,878 s / 87 | 9,057 s / 16 |
| Inference FPS | 8,00 | 1,77 |
| Mean / p95 inference | 84,72 / 99,60 ms | 48,71 / 109,70 ms |
| Mean / p95 tạo bitmap | 0,78 / 1,20 ms | 0,78 / 2,20 ms |
| Mean / p95 từ trước tạo bitmap đến nhận kết quả | 86,12 / 100,60 ms | 50,19 / 111,40 ms |
| Có pose | 87/87 | 16/16 |
| rAF harness / long tasks main thread quan sát | 88,53/s / 0 | 66,13/s / 0 |

Thử nghiệm GPU rất ít mẫu; hai lần trước chỉ thu một mẫu sau warm-up với adaptive interval không được chặn, do đó không thể đánh giá GPU. Lần trong bảng có giới hạn interval 200 ms; CPU và GPU do đó không hoàn toàn cùng scheduler. Chrome headless không chứng minh delegate đang dùng GPU vật lý thực; chưa phân tích trình điều khiển hoặc UI thực. Cách đo worker, khối lượng copy và lịch khác harness main-thread, nên không quy chênh lệch p95 hay rAF thành mức tăng hiệu năng sản phẩm. Không có kiểm chứng tương thích Chrome/Edge thực trên nhiều máy hoặc đo độ tuổi kết quả, tiêu thụ tài nguyên, memory leak và kết quả lâm sàng.

Module Worker thử riêng thất bại khi khởi tạo cả CPU và GPU với `Error: ModuleFactory not set` từ MediaPipe 0.10.35; classic Worker khởi tạo được trong môi trường này. Lệnh chạy từ `e2e`: `node tracking-worker-probe.cjs "<video cục bộ>" CPU classic` (hoặc `GPU classic`, `CPU module`); cần Vite đang chạy và có thể đặt `TRACKING_BENCH_URL`. Không có video nào được sao chép vào project hoặc upload.

## So sánh bộ lọc trên cùng đầu ra Pose

Ngày 28-10-2026 chạy `tracking-filter-probe.cjs` hai lần trên video cục bộ và Chromium headless. Script dùng cùng các quan sát Pose Lite CPU cho raw, EMA theo thời gian (`tau=100 ms`) và One Euro `one-euro-v1` (`minCutoff=1`, `beta=0,5`, `dCutoff=1`, reset 500 ms). Landmark chỉ ở trong bộ nhớ trình duyệt; script chỉ in số liệu tổng hợp. Mỗi lần chọn tự động cửa sổ 2 giây, tối thiểu 10 quan sát và không có khoảng trống quá 500 ms, theo ngưỡng biến thiên raw được ghi trong script. Hai lần có 144 và 126 lần inference; lần lượt 2 và 3 lần không thấy cả hai cổ tay.

Lần một chọn được cửa sổ cổ tay phải 3,137–5,120 s, 27 mẫu, đường kính raw 0,0382 trong tọa độ chuẩn hóa. Độ phân tán vị trí (RMS khoảng cách đến trung bình hai chiều) là raw **0,00998**, EMA **0,00930** và One Euro **0,01151**. One Euro không cải thiện chỉ số này trong cửa sổ đó. Lần hai không tìm được cửa sổ đạt ngưỡng ít chuyển động: không thể kết luận mức giảm rung ổn định.

Cửa sổ có đường kính raw lớn nhất lần một cho độ lệch RMS so với raw cùng thời điểm là EMA **0,0157**, One Euro **0,0331**; dịch thời gian khớp raw tốt nhất theo phép nội suy là **20 ms** và **70 ms**. Lần hai cho RMS **0,1133** và **0,1402**, dịch tốt nhất **20 ms** và **30 ms**. Hai cửa sổ có đường kính raw lớn hơn 1 đơn vị chuẩn hóa, có thể chứa lỗi nhận diện hoặc thay đổi thật, và chưa được người đánh giá xác nhận. Đây là phép khớp với raw, phụ thuộc chọn cửa sổ và tốc độ lấy mẫu, **không phải** độ trễ vật lý, độ chính xác hay rung tuyệt đối. Không đủ căn cứ chứng minh filter làm mượt hoặc theo sát tốt hơn; cần kiểm tra video được gắn nhãn và các đoạn đứng yên/chuyển động thực, đồng thời tránh làm mất chuyển động nhỏ.

Sau khi sửa xử lý điểm ngoài ảnh, một lượt thăm dò `tracking-filter-sweep.cjs` trên 107 lần inference chọn tự động một cửa sổ ít chuyển động: độ phân tán raw **0,01049**, EMA **0,00975**, One Euro mặc định **0,01278**, beta 2 **0,01132**, minCutoff 2 **0,01062**. Trong cửa sổ chuyển động riêng, độ dịch thời gian khớp raw tốt nhất lần lượt là **40**, **110**, **70** và **60 ms** cho bốn cấu hình lọc. Những cửa sổ tự chọn có thể chứa chuyển động thật; đây không phải ground truth hay độ trễ vật lý, và một lượt không đủ căn cứ chọn lại tham số mặc định.

Nhãn `one-euro-v1` trong các báo cáo lịch sử không phân biệt được phép đo trước và sau khi bổ sung reset riêng cho landmark ngoài ảnh. Phiên bản sản phẩm hiện tại là `one-euro-v3`, có thêm chính sách reset lịch sử mốc Pose khi thiếu visibility; các thông số lọc không đổi. Không chỉnh lại nhãn của các phép đo đã lưu để tránh tạo thông tin lịch sử không có sẵn.

Probe `tracking-frozen-frame-filter.cjs` bổ sung phép thử **ảnh cố định với thời gian mô phỏng**, không thay thế benchmark video phát thực: lấy năm frame tại 3, 5, 7, 9, 11 giây vào canvas trong bộ nhớ; trên mỗi frame chạy 75 inference với timestamp mô phỏng 30 Hz, bỏ 15 mẫu đầu, so sánh cùng quan sát raw, EMA 100 ms và One Euro v2. Hai lượt Chrome headless CPU cho kết quả giống nhau. Trong 22 trường hợp có ít nhất 40 mẫu hợp lệ, One Euro có RMS quanh trung bình thấp hơn raw ở 21 trường hợp; ví dụ cổ tay trái tại 3 giây raw **0,02850**, EMA **0,01814**, One Euro **0,01548** theo đơn vị chiều cao ảnh, với RMS lệch One Euro so với raw **0,02174**. Cổ tay trái tại 7 giây là ngoại lệ: raw **0,06216**, One Euro **0,07091**, 59/60 mẫu hợp lệ. Hai khuỷu chỉ đủ dữ liệu ở frame 11 giây. Lặp một ảnh với thời gian nhân tạo không đo chuyển động thật, độ chính xác lâm sàng hay độ trễ vật lý; không suy từ kết quả này rằng bộ lọc luôn giảm rung. Tái lập khi Vite chạy trên cổng 4211 bằng `node tracking-frozen-frame-filter.cjs "<video cục bộ>"` trong `e2e`; chỉ xuất tổng hợp, không lưu frame hoặc landmark.

Probe `tracking-filter-fixed-windows.cjs` so sánh raw, EMA 100 ms và One Euro v2 trên các cửa sổ media-time cố định [3,5), [5,7), [7,9), [9,11) giây. Hai lượt video thực có 133 và 144 inference. Mỗi cửa sổ cần ít nhất 10 mốc hợp lệ, bao phủ ít nhất 1,5 giây và không có khoảng mất mốc trên 500 ms; cả tám cửa sổ cổ tay mỗi lượt đạt điều kiện, nhưng không cửa sổ khuỷu nào đạt. Trên 16 cửa sổ cổ tay, tổng quãng đường One Euro/raw là **0,39–0,83**, EMA/raw **0,55–0,90**; độ dịch khớp raw tốt nhất lần lượt **80–210 ms** và **20–80 ms**. Khoảng cách được quy đổi theo chiều cao ảnh. Raw có thể chứa chuyển động thật và lỗi tracking, nên quãng đường ngắn hơn không chứng minh giảm jitter; độ dịch khớp raw không phải độ trễ vật lý. Không đủ căn cứ đổi thông số. Tái lập với Vite tại cổng 4191 bằng `node tracking-filter-fixed-windows.cjs "<video cục bộ>"` trong `e2e`.

### Kiểm tra One Euro v3

Sau các kiểm thử khác, hai lượt riêng dùng video gốc cho **98 / 106 inference**. Với bốn cửa sổ media-time cố định như trên, cả **16/16** cửa sổ cổ tay của hai lượt đạt điều kiện, nhưng **0/16** cửa sổ khuỷu đạt điều kiện. Tỷ lệ tổng quãng đường so với raw ở cổ tay là **0,415–0,873** cho One Euro v3 và **0,572–0,914** cho EMA. Độ dịch thời gian cho khớp với raw tốt nhất là **60–240 ms** với One Euro v3 và **10–100 ms** với EMA. Các cửa sổ chưa được xác nhận là đứng yên hay chuyển động; raw là đầu ra model, không phải ground truth. Vì vậy, quãng đường giảm có thể gồm cả việc làm mất chuyển động thật, và độ dịch khớp không đo độ trễ vật lý. Hai lượt trước với 138 / 144 inference trùng thời gian kiểm thử PostgreSQL và không được gộp như các lượt đo có cùng điều kiện với hai lượt riêng này.

Đối chứng ảnh cố định dùng năm frame thực tại 3, 5, 7, 9 và 11 giây; mỗi frame được suy luận lặp 75 lần với timestamp 30 Hz mô phỏng, bỏ 15 mẫu đầu. Trong **22** trường hợp đủ dữ liệu, RMS quanh trung bình của One Euro v3 thấp hơn raw ở **21** trường hợp. Ví dụ cổ tay trái tại 3 giây: raw **0,02850**, EMA **0,01814**, v3 **0,01548**; ngoại lệ cổ tay trái tại 7 giây: raw **0,06216**, v3 **0,07091**. Khoảng cách tính theo đơn vị chiều cao ảnh. Ảnh lặp với thời gian nhân tạo không có chuyển động thực, không đo rung của người đứng yên, độ trễ vật lý hoặc độ chính xác; không thể kết luận bộ lọc luôn giảm rung. Hai phép thử minh họa đánh đổi giữa độ biến thiên đầu ra model và độ bám raw, chưa chứng minh an toàn cho chuyển động phục hồi chức năng.

Tái lập với Vite trên localhost cổng 4191: trong `e2e` đặt `$env:TRACKING_BENCH_URL = 'http://127.0.0.1:4191'`, rồi chạy `node tracking-filter-fixed-windows.cjs "<video cục bộ>"` và `node tracking-frozen-frame-filter.cjs "<video cục bộ>"`. Script chỉ in thống kê tổng hợp, không lưu video, frame hay landmark.

### So sánh ghép cặp cấu hình làm mượt

Hai lượt `tracking-filter-paired-video.cjs` đưa cùng đầu ra Pose vào One Euro v3 mặc định, các biến thể và EMA 100 ms: 111 / 114 inference; cả 16 cửa sổ cổ tay đủ điều kiện, 0/16 cửa sổ khuỷu đủ điều kiện. Với `minCutoff=2`, độ dịch khớp raw nhỏ hơn mặc định ở 15/16 cửa sổ và bằng nhau ở một cửa sổ: khoảng dịch tốt nhất lần lượt 0–80 ms so với 0–180 ms; RMS lệch raw thấp hơn ở 16/16. Trong hai lượt `tracking-filter-paired-frozen.cjs` có cùng số đếm, biến thể này có RMS quanh trung bình cao hơn mặc định trong 20/22 trường hợp đủ mẫu, nhưng thấp hơn raw trong 21/22. Ví dụ cổ tay trái ở frame 3 giây: raw 0,02850, mặc định 0,01548 và `minCutoff=2` 0,01877 theo đơn vị chiều cao ảnh. Ảnh lặp với timestamp mô phỏng không chứa chuyển động thật.

Probe `tracking-synthetic-filter.cjs` dùng quỹ đạo giả có ground truth, timestamp không đều và nhiễu có seed. RMS đứng yên là raw 0,00589, mặc định 0,00202, `beta=2` 0,00205 và `minCutoff=2` 0,00256. Ở ramp, RMS lần lượt của ba cấu hình lọc là 0,01940 / 0,01642 / 0,01050. Đây là tín hiệu tổng hợp; kết quả không chứng minh độ chính xác, độ trễ vật lý hay hiệu quả lâm sàng. Trong Lab có thể thử **Đáp ứng nhanh** (`minCutoff=2`) để so sánh hiển thị, chấp nhận khả năng rung hơn; mặc định không đổi và raw vẫn được giữ riêng.

Tái lập hai probe video và ảnh cố định với Vite localhost cổng 4281, đặt `TRACKING_BENCH_URL` tương ứng rồi chạy `node tracking-filter-paired-video.cjs "<video cục bộ>"` và `node tracking-filter-paired-frozen.cjs "<video cục bộ>"` trong `e2e`; chỉ xuất thống kê tổng hợp. Probe tổng hợp chạy `node tracking-synthetic-filter.cjs` trong `e2e`, không cần video hoặc mạng.

Có thể chạy lại khi Vite hoạt động: `node tracking-filter-probe.cjs "<đường dẫn video cục bộ>"` trong `e2e`. Lần chạy có thể chọn cửa sổ khác khi tốc độ suy luận thay đổi; không lưu ảnh, video hay landmark ra file.

## Thử giảm độ phân giải đầu vào

Hai lượt đo tuần tự trên cùng video cục bộ 1920 × 1080, Chrome headless, Pose Lite CPU, scheduler hiện tại giới hạn 24 FPS và warm-up 3 giây. Lượt 1 chạy native → 1280 → 640; lượt 2 đảo thứ tự. Video chạy theo thời gian thực; 1280 và 640 là chiều rộng canvas 2D, giữ tỉ lệ, tính cả `drawImage` trong thời gian tổng. Đây là probe độc lập, không đo overlay, trò chơi, worker hay toàn bộ UI.

| Đầu vào inference | Lượt | Inference/s | Mean tổng | p95 tổng | p95 `drawImage` | Pose có kết quả | Cả sáu mốc vai/khuỷu/cổ tay visibility ≥ 0,4 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Native 1920 × 1080 | 1 | 12,63 | 48,47 ms | 84,50 ms | — | 136/136 | 133/136 (97,8%) |
| 1280 × 720 | 1 | 14,21 | 43,19 ms | 64,60 ms | 0,60 ms | 153/153 | 148/153 (96,7%) |
| 640 × 360 | 1 | 13,07 | 45,21 ms | 75,00 ms | 0,70 ms | 141/141 | 134/141 (95,0%) |
| 640 × 360 | 2 | 10,17 | 63,82 ms | 96,20 ms | 1,60 ms | 111/111 | 108/111 (97,3%) |
| 1280 × 720 | 2 | 10,95 | 58,27 ms | 65,10 ms | 0,50 ms | 118/118 | 116/118 (98,3%) |
| Native 1920 × 1080 | 2 | 10,21 | 65,63 ms | 77,60 ms | — | 110/110 | 108/110 (98,2%) |

Các cặp đo liền kề gợi ý 1280 có p95 thấp hơn native trong môi trường này, nhưng FPS và thời gian trung bình biến thiên đáng kể giữa các lượt; 640 không cải thiện nhất quán. Những tỷ lệ visibility chỉ phản ánh ngưỡng model báo trên các frame được chọn, không chứng minh độ chính xác. Điều kiện tải khác các benchmark trước; không so các trị số ở đây với benchmark worker như một thử nghiệm đối chứng.

Để đánh giá rủi ro sai khác, một probe khác dùng ba model Pose VIDEO CPU độc lập, seek cùng các thời điểm cách 0,5 giây trong cùng video, làm nóng bằng các mẫu trước giây thứ 3, rồi so sánh **cùng 21 frame**; các bộ lọc/display và scheduler realtime không chạy. Chỉ so các cặp mốc có visibility ≥ 0,4 ở cả hai model; tất cả sáu mốc đều thỏa ở 21/21 frame cho cả ba độ phân giải. Khoảng cách là Euclid trong tọa độ x/y chuẩn hóa, không quy đổi theo tỉ lệ khung; native là tham chiếu model, không phải ground truth.

| Mốc | 1280 so với native: mean / p95 | 640 so với native: mean / p95 |
| --- | ---: | ---: |
| Vai trái | 0,0116 / 0,0286 | 0,0186 / 0,0332 |
| Vai phải | 0,0142 / 0,0230 | 0,0246 / 0,0413 |
| Khuỷu trái | 0,0540 / 0,1447 | 0,0777 / 0,1834 |
| Khuỷu phải | 0,0281 / 0,0934 | 0,0547 / 0,0878 |
| Cổ tay trái | 0,0686 / 0,3991 | 0,1363 / 0,4614 |
| Cổ tay phải | 0,0240 / 0,0545 | 0,0264 / 0,0375 |

Hai lần chạy probe ghép cặp cho cùng số liệu trong môi trường này. Với chỉ 21 frame, p95 nhạy với vài điểm; hai bộ theo dõi độc lập ở 2 Hz cũng không tái hiện đầy đủ tracker realtime. Sai khác lớn ở một số mốc dù visibility cao là lý do **không tự động bật giảm kích thước inference** dựa trên FPS. Không thể xác định đầu ra nào đúng hơn nếu không có frame và landmark được gắn nhãn; cần đo thêm nhiều người, chuyển động, che khuất và khoảng cách. Video gốc và từng landmark chỉ ở trong bộ nhớ browser, không được lưu, sao chép hoặc tải lên.

Tái lập từ thư mục `e2e` khi Vite chạy trên 5173: `node tracking-resolution-probe.cjs "<video cục bộ>" native` (hoặc `1280`, `640`) và `node tracking-resolution-agreement.cjs "<video cục bộ>"`. Hai script chỉ in metadata và thống kê tổng hợp.

## So sánh trực tiếp hai chế độ trong Tracking Test Lab

Đo lại ngày 28-10-2026 trên bản build production, Chrome headless 156, cùng video 1920 × 1080, Pose Lite CPU, Balanced, One Euro hiển thị và không bật Hand. Mỗi lượt phát ở tốc độ 1×, warm-up ba giây rồi đo khoảng tám giây; thứ tự main → Worker lặp hai lần. Máy có tải nền đáng kể (khoảng 40% tổng CPU và 1,9 GB RAM còn trống khi kiểm tra trước lượt đo); đây không phải phép đo riêng mức sử dụng CPU/GPU/memory của ứng dụng. Script `e2e/tracking-lab-benchmark.cjs` thu JSON tổng hợp trực tiếp từ Lab, không lưu video hay landmark.

| Chỉ số | Main lần 1 | Worker lần 1 | Main lần 2 | Worker lần 2 |
| --- | ---: | ---: | ---: | ---: |
| Thời gian đo (s) | 8,28 | 8,07 | 8,08 | 8,07 |
| Inference/s | 6,28 | 8,55 | 10,28 | 8,68 |
| Inference mean / p95 (ms) | 110,64 / 150,80 | 81,81 / 133,90 | 63,86 / 109,60 | 82,61 / 120,80 |
| Worker callback → kết quả p95 (ms) | — | 137,50 | — | 124,60 |
| Render/s | 35,53 | 90,01 | 45,32 | 90,01 |
| Overlay p95 (ms) | 0,30 | 0,30 | 0,20 | 0,30 |
| Frame bị giới hạn / Worker bận | 31 / 0 | 109 / 61 | 18 / 0 | 107 / 62 |
| Có đầu ra model | 52/52 | 69/69 | 83/83 | 70/70 |
| Cả vai/khuỷu/cổ tay trái đủ ngưỡng và trong ảnh | 15,4% | 7,2% | 9,6% | 10,0% |
| Cả vai/khuỷu/cổ tay phải đủ ngưỡng và trong ảnh | 15,4% | 10,1% | 12,0% | 12,9% |

Các mẫu ở mỗi lượt khác thời điểm; tỷ lệ có đầu ra model không có nghĩa cả chi trên đáng tin cậy. Tỷ lệ thấp của chỉ số kết hợp sáu mốc là cảnh báo cần kiểm tra tư thế, phạm vi khung và mốc đã gắn nhãn; không tự suy ra nguyên nhân hay độ chính xác. Số render/s là tốc độ vòng vẽ trong Chrome headless, không phải tần số màn hình vật lý. Hai cặp cho kết quả inference trái chiều, Worker render thường xuyên hơn trong môi trường này nhưng latency/throughput dao động; không đủ căn cứ chọn Worker làm mặc định hoặc khẳng định cải thiện lâm sàng. Worker round-trip gồm tạo/chuyển ảnh và thời gian chờ, inference là thời gian model trong Worker; fps video là callback quan sát, không phải toàn bộ frame nguồn. Không đo jitter có ground truth, motion-to-photon hoặc tài nguyên riêng từng tiến trình.

Tái lập: chạy bản build và `npx vite preview --host 127.0.0.1 --port 4178`, sau đó đặt `TRACKING_BENCH_URL=http://127.0.0.1:4178` theo cú pháp shell và chạy `node tracking-lab-benchmark.cjs "<video cục bộ>" 2` trong `e2e`. Không sử dụng trace, ảnh hay video kiểm thử trong báo cáo.

Sau sửa scheduler `presentedFrames` và xử lý mốc ngoài ảnh, chạy lại cùng script trên bản production ngày 28-10-2026, Chrome headless 156, Pose Lite CPU, Balanced, 3 giây warm-up và 8 giây đo mỗi lượt, thứ tự main → Worker lặp hai lần:

| Chỉ số | Main 1 | Worker 1 | Main 2 | Worker 2 |
|---|---:|---:|---:|---:|
| Inference/s | 12,05 | 11,05 | 12,74 | 11,54 |
| Inference p95 (ms) | 65,3 | 78,7 | 67,1 | 72,0 |
| Worker callback đến kết quả p95 (ms) | — | 79,8 | — | 74,7 |
| FPS video callback quan sát | 12,66 | 29,68 | 14,23 | 29,65 |
| FPS vòng render | 48,93 | 90,04 | 54,44 | 90,07 |
| Vai/khuỷu/cổ tay trái đủ điều kiện | 12,2% | 9,0% | 11,7% | 8,6% |
| Vai/khuỷu/cổ tay phải đủ điều kiện | 15,3% | 12,4% | 14,6% | 10,8% |

Các số này đo các mẫu thời điểm khác nhau và chịu tải máy biến thiên; không suy ra thay đổi hiệu năng do scheduler từ việc so trực tiếp với các lượt trước. FPS vòng render không phải FPS màn hình, callback quan sát không phải số frame nguồn, và tuổi kết quả tại một thời điểm không phải latency từ camera tới màn hình. Các tỷ lệ chỉ mô tả điều kiện đầu ra model, không phải độ chính xác.

## Profile trên cùng video file

Trên production preview với Chrome headless 156, video gốc 1080p phát 1×, Pose Lite CPU main, Hand tắt, One Euro v2, warm-up 3 giây và đo khoảng 8 giây, chạy Economy → Balanced → Quality rồi đảo thứ tự. Inference/s hai lượt lần lượt là **11,43 / 11,91**, **16,31 / 12,24**, **12,85 / 12,62**; p95 inference tương ứng **70,8 / 68,2 ms**, **47,2 / 69,3 ms**, **67,4 / 66,6 ms**. Số callback bị giới hạn là **49 / 40**, **7 / 17**, **14 / 20**. Tỷ lệ đủ cả vai/khuỷu/cổ tay trái là **11,8 / 10,4%**, **9,1 / 11,1%**, **8,7 / 8,8%**; bên phải **14,0 / 11,5%**, **12,1 / 13,1%**, **11,5 / 10,8%**. Từng lượt xét các frame khác nhau, thời gian thay đổi đáng kể và tỷ lệ đủ điều kiện không đo độ chính xác; không đủ chứng minh profile nào tốt hơn trên thiết bị khác. File được xử lý nguyên 1920 × 1080 ở cả ba profile, nên phép này **không đo** tùy chọn độ phân giải camera theo profile. Tái lập trên production preview bằng `node tracking-profiles-benchmark.cjs "<video cục bộ>"` trong `e2e`, đặt `TRACKING_BENCH_URL` tới origin localhost. Probe chỉ in tổng hợp và chặn mạng ngoài localhost.

## Chẩn đoán vì sao tỷ lệ đủ ba mốc thấp

Probe `e2e/tracking-validity-probe.cjs` chạy Pose Lite CPU trong Chrome headless trên cùng video cục bộ. Trong hai lượt độc lập ở đoạn 3–11 giây (scheduler Balanced tối đa 24 FPS), số mẫu là 60 và 57. Probe chỉ tính tổng theo khoảng hai giây trong bộ nhớ browser và in số đếm, không lưu video, khung hình hoặc tọa độ landmark. Tại lượt thứ hai, model có Pose ở 57/57 mẫu; tất cả sáu mốc vai/khuỷu/cổ tay có tọa độ hữu hạn và visibility ≥0,4. Tuy nhiên, ước lượng khuỷu trái và phải có `y > 1` (ngoài mép dưới ảnh) lần lượt **52/57** và **52/57**. Vai nằm trong ảnh ở 57/57 cho mỗi bên; cổ tay trái 55/57 và phải 57/57. Cả ba mốc cùng đủ điều kiện *visibility và nằm trong ảnh* là **5/57** ở mỗi bên. Lượt đầu có 60 mẫu, hai khuỷu ngoài miền `y` lần lượt 55/60 và 54/60. Các mẫu giữa hai lượt không trùng hoàn toàn vì scheduler realtime.

Điều này giải thích sự khác biệt trong phép đếm: probe độ phân giải ở trên chỉ kiểm tra visibility ≥0,4, còn Lab yêu cầu thêm tất cả tọa độ hữu hạn và nằm trong ảnh. Các kết quả trên chỉ là **đầu ra model**, không chứng minh vị trí khuỷu thực nằm ngoài ảnh hay mô hình đã đúng/sai. Có visibility cao không bảo đảm landmark hợp lệ trong ảnh hoặc chính xác. Cần người có chuyên môn kiểm tra tư thế, khung hình và landmark được gắn nhãn trước khi kết luận về độ chính xác hoặc khả năng sử dụng; không tự hạ ngưỡng hay cắt tọa độ để che vấn đề.

Tái lập: khi Vite đang chạy, từ `e2e` đặt `TRACKING_BENCH_URL` tới Vite nếu khác `http://127.0.0.1:5173`, rồi chạy `node tracking-validity-probe.cjs "<video cục bộ>"`. Các mục `outsideX`, `outsideY`, `lowVisibility` có thể chồng lấn và không được cộng như các nhóm loại trừ; `eligible` là giao của hữu hạn, trong ảnh và visibility ≥0,4.

## So sánh Pose Lite và Full trên frame ghép cặp

Ngày 28-10-2026 dùng cùng video cục bộ 1920 × 1080 dài 13,74 giây, Chrome headless 156, MediaPipe Tasks Vision 0.10.35, VIDEO, CPU, một người và ngưỡng mặc định MediaPipe. Hai tracker độc lập cùng seek mỗi 0,5 giây, làm nóng ở 0,5–2,5 giây, sau đó xử lý cùng 21 frame, đảo thứ tự Lite/Full theo từng frame. Hai lượt lặp cho cùng các số đếm và sai khác; thời gian khác do tải máy. Từng frame và landmark chỉ nằm trong bộ nhớ trình duyệt; chỉ in tổng hợp. Probe chặn truy cập mạng ngoài origin Vite và không upload hoặc sao chép video.

Full được tải về thư mục tạm từ [bundle Full trong hướng dẫn chính thức](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker); [model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf) nêu Apache 2.0 và giới hạn sử dụng. SHA-256 Full `4eaa5eb7a98365221087693fcc286334cf0858e2eb6e15b506aa4a7ecdcec4ad`, Lite hiện có `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a`. Không đưa Full vào sản phẩm.

| Chỉ số | Lite | Full |
|---|---:|---:|
| Có Pose | 21/21 | 21/21 |
| Thời gian trung bình lượt 1 / 2 (ms) | 53,75 / 74,19 | 85,97 / 116,53 |
| p95 lượt 1 / 2 (ms) | 72,70 / 101,10 | 112,40 / 157,80 |
| Vai trái / phải đủ điều kiện | 21 / 21 | 21 / 21 |
| Khuỷu trái / phải đủ điều kiện | 2 / 2 | 1 / 2 |
| Cổ tay trái / phải đủ điều kiện | 17 / 19 | 20 / 19 |

Điều kiện là tọa độ x/y hữu hạn và nằm trong [0,1], visibility ≥0,4. Trong các frame cả hai model đủ điều kiện, khoảng cách Euclid trung bình / p95 của vai trái là 0,020 / 0,042 (21 cặp), vai phải 0,032 / 0,058 (21), khuỷu phải 0,029 / 0,030 (2), cổ tay trái 0,048 / 0,122 (17), cổ tay phải 0,018 / 0,036 (19); khuỷu trái không có cặp đủ điều kiện. Tọa độ x/y chuẩn hóa theo từng trục, không hiệu chỉnh tỉ lệ khung. Đây là sai khác giữa hai model, không phải sai số so với ground truth: nhiều landmark được báo đủ điều kiện cũng có thể sai. Các tracker được chạy ở 2 Hz, không giống realtime, và thời gian chỉ là `detectForVideo` trong harness seek, không phải FPS hay độ trễ UI; p95 với 21 mẫu không ổn định. Một video không đủ kết luận về độ chính xác, lâm sàng hay thiết bị khác. Chưa có căn cứ đổi model mặc định.

Tái lập: tải bundle Full từ link chính thức vào đường dẫn cục bộ tạm, chạy Vite trong `frontend`, rồi chạy `node tracking-model-agreement.cjs "<video cục bộ>" "<model Full cục bộ>"` trong `e2e`; có thể đặt `TRACKING_BENCH_URL` theo cổng Vite. Không ghi video hoặc landmark vào báo cáo.

## Thăm dò ngưỡng Pose

Hai lượt Chrome headless CPU với Pose Lite dùng cùng video cục bộ, 5 frame warm-up và 21 frame ghép cặp được seek cách 0,5 giây. Đồng thời đặt cả ba ngưỡng detection, presence và tracking ở 0,3, 0,5 hoặc 0,7; thêm một tracker độc lập cùng mức 0,5 làm đối chứng. Cả ba cấu hình đều có Pose 21/21; số frame đủ điều kiện vai/khuỷu/cổ tay trái và phải lần lượt là **3/2**, **2/2** và **2/2**. Khoảng cách p95 của cổ tay trái so với mức 0,5 là **0,112** với 0,3 và **0,137** với 0,7, dựa trên 16 cặp cùng đủ điều kiện; hai tracker cùng mức 0,5 có khoảng cách bằng 0 tại các cặp đủ điều kiện. Hai lượt có cùng số đếm. Khoảng cách tọa độ chuẩn hóa giữa các đầu ra không phải sai số so với ground truth. Các ngưỡng thay đổi đồng thời, mẫu seek 2 Hz không đại diện realtime và một video không xác định được độ chính xác; chưa có căn cứ đổi ngưỡng mặc định.

Tái lập bằng `node tracking-threshold-probe.cjs "<video cục bộ>"` trong `e2e` khi Vite chạy; script chỉ in số liệu tổng hợp và chặn truy cập mạng ngoài origin Vite.

## Kiểm tra visibility của Hand

Probe `tracking-hand-visibility-probe.cjs` dùng Hand Landmarker CPU VIDEO của MediaPipe 0.10.35 trên video cục bộ, seek cách 0,25 giây: 50/54 frame có tay, tổng 99 bàn tay và 2.079 landmark; cả 2.079 mốc có `visibility = 0` và x/y hữu hạn trong ảnh. Một probe độc lập lấy 27 frame cũng ghi 987/987 mốc Hand có visibility 0. Đây là các đầu ra model, không phải đánh giá độ chính xác. Trước sửa, ngưỡng visibility 0,4 dùng chung Pose và Hand khiến skeleton Hand không hiển thị. Quy tắc vẽ hiện giữ kiểm tra tọa độ cho cả hai, nhưng chỉ áp dụng ngưỡng visibility cho Pose; Hand không dùng trường visibility làm tiêu chí hiển thị. Tái lập probe qua Vite cổng 4215 bằng `node tracking-hand-visibility-probe.cjs "<video cục bộ>"`; số liệu chỉ tổng hợp, không lưu video hoặc landmark.

## Chi phí Pose cùng Hand

Trên Lab production, Chrome headless 156, video 1080p phát 1×, Balanced, CPU main, warm-up 3 giây và đo khoảng 8 giây, thứ tự Pose → Pose+Hand → Pose+Hand → Pose. Hai lượt Pose đạt **9,17 / 9,79 inference/s**, p95 **108,5 / 77,2 ms**; hai lượt Pose+Hand đạt **3,35 / 3,22 inference/s**, p95 tổng **268,6 / 278,0 ms**. Callback bị giới hạn lần lượt **18 / 17** so với **44 / 43**; số vòng render/s là **40,2 / 43,6** so với **28,4 / 28,9**. Phép đo tổng không tách được tần suất hay thời gian Hand riêng; các lượt xử lý frame khác nhau, tải nền không được kiểm soát và headless không đại diện mọi laptop. Chi phí đồng thời đáng kể trong môi trường đo này, nhưng các số không chứng minh độ chính xác hoặc hiệu quả lâm sàng. Tái lập `node tracking-pose-hand-benchmark.cjs "<video cục bộ>"` trong `e2e` khi có production preview; script chỉ in tổng hợp và chặn API.

Probe độc lập `tracking-hand-rate-probe.cjs` dùng scheduler hiện tại, Chrome headless CPU, cùng video 1080p, warm-up 3 giây, cửa sổ media-time 8 giây, hai lượt đảo thứ tự. Hand tắt cho Pose **9,00 / 8,75 FPS**, p95 tổng **103,8 / 113,4 ms**. Giới hạn Hand 2 Hz cho Pose **5,25 / 4,88 FPS**, Hand thực **1,75 / 1,63 FPS**, p95 tổng **238,1 / 258,7 ms**, p95 khoảng giữa hai kết quả Pose **266,7 / 299,6 ms**. Giới hạn 5 Hz cho Pose/Hand **3,38 / 3,25 FPS**, p95 tổng **267,9 / 295,3 ms**; giới hạn 12 Hz cho Pose/Hand **3,13 / 3,38 FPS**, p95 tổng **295,7 / 267,6 ms**. Các lượt lấy frame khác nhau và không gồm overlay/UI, ground truth hay tài nguyên toàn hệ thống. Giới hạn 2 Hz giúp tăng nhịp Pose so với 5/12 Hz trong harness này, nhưng Hand chỉ khoảng 1,6–1,8 Hz và có thể bỏ lỡ động tác; chưa có căn cứ đổi mặc định. Tái lập với Vite cổng 4231 bằng `node tracking-hand-rate-probe.cjs "<video cục bộ>"` trong `e2e`; probe chỉ in số liệu tổng hợp.

Prototype `tracking-parallel-workers-probe.cjs` so sánh một Worker chạy nối tiếp với hai Worker riêng Pose và Hand, mỗi Worker tối đa một capture/inference đang xử lý. Trên video 1080p, Chrome headless 156 CPU, warm-up 3 giây, cửa sổ 8 giây, thứ tự serial → parallel → parallel → serial, một Worker đạt Pose/Hand **3,63–3,88 FPS**, p95 callback → Pose **283,9–337,0 ms**, p95 khoảng giữa kết quả Pose **299,8–355,3 ms**; hai Worker đạt Pose **9,25–9,50 FPS**, Hand **5,25–5,50 FPS**, p95 callback → Pose **110,3–111,5 ms**, p95 khoảng giữa kết quả Pose **133,6–144,4 ms**. Đây là prototype dùng rVFC, không chạy scheduler hay UI production; hai Worker có thể chụp các frame khác nhau. Không đo tổng CPU/GPU/RAM, độ chính xác hoặc độ trễ từ cảm biến tới màn hình. Kết quả cần được xác minh trong ứng dụng và trên thiết bị thực trước khi chọn cấu hình mặc định. Tái lập với Vite cổng 4241 bằng `node tracking-parallel-workers-probe.cjs "<video cục bộ>" 2` trong `e2e`; chỉ xuất số liệu tổng hợp.

## Hai Worker trong Lab production

Đo trong giao diện Lab của bản build production với cùng video cục bộ 1920 × 1080 phát 1×, Chrome headless 156, Balanced, Pose và Hand CPU. Sau 3 giây warm-up, mỗi lượt đo khoảng 8 giây; thứ tự là một Worker nối tiếp → hai Worker → hai Worker → một Worker. Hai Worker là lựa chọn thử nghiệm trong Lab và Workspace; các số dưới đây chỉ đo Lab, không phải benchmark Workspace.

| Chỉ số | Một Worker, hai lượt | Hai Worker, hai lượt |
| --- | ---: | ---: |
| Pose inference/s | 2,72 / 2,22 | 6,68 / 6,28 |
| Hand inference/s | Không tách riêng | 3,71 / 3,45 |
| Callback video → kết quả Pose p95 (ms) | 402,0 / 442,6 | 167,1 / 175,1 |
| Callback video → kết quả Hand p95 (ms) | Không tách riêng | 293,7 / 327,0 |

Ở một Worker, thời gian suy luận và callback đến kết quả phản ánh lần chạy nối tiếp Pose và Hand khi Hand đến hạn; không thể suy ra latency Hand riêng từ các trường chung. Trong chế độ hai Worker, Pose và Hand được báo riêng và không được cộng các giá trị p95. Hai Worker có thể chụp các frame khác nhau và các lượt so sánh không xử lý chính xác cùng frame. Phần trăm frame đủ cả vai/khuỷu/cổ tay theo tiêu chí trong ảnh và visibility ≥0,4 chỉ khoảng 4,5–11,8% tùy bên và lượt; đây là điều kiện đầu ra, không phải độ chính xác. Mỗi lượt đóng đủ Worker đã tạo: 1/1 ở chế độ nối tiếp và 2/2 ở chế độ song song. Kiểm thử Playwright chuyên biệt qua video cục bộ đạt 1/1, bao gồm tạo, đo và đóng hai Worker. Mẫu ngắn, tải nền không được kiểm soát; chưa đo tổng CPU/GPU/RAM, thời gian dài, webcam có người, độ chính xác hay độ trễ từ cảm biến đến màn hình. Các số này không bảo đảm lợi ích trên laptop khác hoặc tính phù hợp lâm sàng.

Tái lập: chạy `npm run build`, rồi `npx vite preview --host 127.0.0.1 --port 4242` trong `frontend`; trong `e2e` chạy `node tracking-dual-worker-benchmark.cjs "<video cục bộ>" 2`. Có thể đặt `TRACKING_BENCH_URL` tới origin localhost khác. Script đọc file qua bộ chọn trình duyệt, chặn mạng ngoài localhost và chỉ in số liệu tổng hợp; không sao chép, upload hoặc lưu video. Benchmark không lưu frame hay landmark.

### Chi phí tài nguyên của hai Worker trong Lab

Hai lượt trên Chrome headless 156 dùng cùng video cục bộ 1080p phát 1×, warm-up 3 giây, cửa sổ khoảng 6,6–6,9 giây; mỗi lượt tạo browser mới. Đối chứng là chỉ phát preview, một Worker chạy Pose và Hand nối tiếp, và hai Worker chạy riêng. CDP `SystemInfo.getProcessInfo` cung cấp PID và CPU time; Windows `Get-Process` cung cấp bộ nhớ từng PID. Cả hai thời điểm đầu và cuối mỗi cửa sổ đều có đủ cùng 8 PID Chrome. Lần chạy hai vòng theo thứ tự preview → một Worker → hai Worker rồi đảo ngược; vòng đầu trùng thời gian với probe khác nên cả ba mẫu đã bị loại. Các mẫu giữ lại là vòng đảo ngược **hai Worker → một Worker → preview**, tiếp theo một vòng riêng **preview → một Worker → hai Worker**.

| Chỉ số | Preview, hai lượt | Một Worker, hai lượt | Hai Worker, hai lượt |
| --- | ---: | ---: | ---: |
| Tổng CPU Chrome (% của một logical core) | 61,5 / 77,2 | 161,3 / 154,6 | 201,7 / 238,5 |
| Private committed memory cuối cửa sổ (MiB) | 438,3 / 441,9 | 819,6 / 813,8 | 851,3 / 847,9 |
| Tổng working set cuối cửa sổ (MiB) | 708,9 / 716,5 | 1155,4 / 1147,0 | 1185,1 / 1181,2 |

CPU 100% tương ứng một logical core, nên tổng nhiều tiến trình có thể vượt 100%; đây là toàn bộ các tiến trình Chrome được báo, gồm UI và phát video, không chỉ chi phí model, và không gồm Vite. Tổng working set có thể đếm lặp trang nhớ dùng chung; private committed memory không phải GPU memory. Đây là ảnh chụp cuối cửa sổ, không phải peak hoặc phép thử dài hạn. Trong điều kiện ngắn này hai Worker dùng CPU và bộ nhớ quan sát được cao hơn một Worker, đồng thời các phép đo Lab ở trên cho thấy nhịp Pose cao hơn; không thể suy ra đánh đổi trên laptop khác, hiệu năng GPU hay chất lượng lâm sàng.

Tái lập trên Windows với production preview tại localhost, đặt `TRACKING_BENCH_URL` nếu khác `http://127.0.0.1:4242`, rồi chạy `node tracking-dual-resource-benchmark.cjs "<video cục bộ>" 2` trong `e2e`. Script chọn video tại chỗ, chặn mạng ngoài localhost và chỉ in số liệu tổng hợp.

## Tự điều chỉnh nhịp hai Worker trong Lab production

Hai lượt mỗi cấu hình trên Chrome headless 156, cùng video cục bộ 1920 × 1080 phát 1×, Pose và Hand CPU, warm-up 3 giây, cửa sổ đo khoảng 8 giây, theo thứ tự cố định → Auto → Auto → cố định. Cấu hình cố định dùng profile Balanced; Auto khởi đầu với trần Pose 30 và Hand 20 FPS, nên đây là phép so sánh hai cấu hình đầy đủ, không chỉ một tham số. Mỗi lượt dùng browser mới. CPU được tính từ các tiến trình Chrome do CDP báo; **100% tương ứng một logical core**, bao gồm Chrome/UI/video và không gồm Vite, không phải mức sử dụng GPU vật lý.

| Chỉ số | Cố định, hai lượt | Auto, hai lượt |
| --- | ---: | ---: |
| Pose inference FPS | 8,00 / 7,65 | 11,13 / 9,91 |
| Callback → Pose p95 | 113,9 / 156,5 ms | 85,2 / 87,9 ms |
| Hand inference FPS | 5,17 / 4,44 | 6,43 / 5,82 |
| Callback → Hand p95 | 218,2 / 271,6 ms | 159,7 / 186,4 ms |
| CPU tổng Chrome | 207,0 / 226,9% | 224,0 / 230,7% |

Hai lượt Auto kết thúc ở trạng thái bình thường với trần 30/20; phép đo này **không chứng minh** cơ chế giảm tải hoạt động khi UI quá tải. Có 8 PID Chrome giống nhau ở hai đầu mỗi lượt, vòng render khoảng 89,5–90 lần/s và không quan sát long task; 2/2 Worker được đóng sau từng lượt. Các frame giữa lượt khác nhau, mẫu ngắn và headless không đại diện mọi laptop, webcam hay độ chính xác lâm sàng. CPU gồm cả browser và các tác vụ khác trong Chrome, không đo GPU vật lý hoặc mức tài nguyên còn lại toàn máy. Đây không phải phép đo của Workspace. Script chỉ in tổng hợp, đọc video tại chỗ và chặn mạng ngoài localhost.

Tái lập: chạy `npm run build`, rồi `npx vite preview --host 127.0.0.1 --port 4266` trong `frontend`. Trong `e2e`, đặt `TRACKING_BENCH_URL` về origin localhost đó và chạy `node tracking-autoscale-benchmark.cjs "<video cục bộ>" 2`.

## Auto dưới áp lực giao diện và chạy liên tục

Trên Lab production với Chrome headless 156 và **camera giả Chromium**, probe `tracking-autoscale-stress.cjs` cố ý chặn main thread khoảng 160 ms mỗi 200 ms. Trong khoảng 9 giây có 47 lần chặn; giới hạn Hand của Auto giảm **20 → 16 → 12,8 FPS** trong khi giới hạn Pose vẫn là **30 FPS**. Sau khi ngừng tạo tải, giới hạn Hand phục hồi lên **14,2 FPS** sau khoảng 9 giây. Đây là giới hạn được quan sát trong giao diện Lab, không phải FPS inference thực tế; 2/2 Worker đã đóng khi dừng. Tải này được tạo nhân tạo để kiểm tra nhánh phản ứng và phục hồi, không đo CPU còn lại toàn máy hay chứng minh hành vi dưới mọi loại quá tải.

Trên **video gốc 1080p phát 1×**, lượt lặp không chạy đồng thời kiểm thử nặng kết thúc khi video ở 11,63/13,74 giây. Probe tạo 47 lần chặn main thread theo mục tiêu 160 ms mỗi 200 ms, tổng thời gian chặn đo được **7531 ms** và lần dài nhất **171,1 ms**. Giới hạn Hand giảm **20 → 16 → 12,8 FPS**, Pose giữ **30 FPS**, và 2/2 Worker đã đóng. Một lượt trước kết thúc ở 11,93/13,74 giây cho cùng các mức giới hạn nhưng có thể trùng kiểm thử CPU khác ở đầu lượt. Do video ngắn, không lượt video nào đo pha phục hồi; kết quả phục hồi ở trên dùng camera giả. Tải giao diện được cố ý tạo và kết quả không dùng để khẳng định mức tài nguyên còn lại.

Một lượt khác chạy Lab production trong **150 giây**, chia năm cửa sổ khoảng 30 giây, trên Chrome headless 156. Nguồn là video gốc 1920 × 1080 phát **1×**, lặp 11 lần trong browser rồi cấp qua `captureStream()` như camera giả; mỗi vòng lặp tạo gián đoạn nội dung và không phải webcam vật lý. Hai Worker Auto cùng phép đo tiếp tục hoạt động trong suốt lượt; giữa các cửa sổ benchmark được reset nên một số frame đang xử lý tại ranh giới có thể không được tính.

| Chỉ số | Kết quả năm cửa sổ |
| --- | ---: |
| Pose / Hand inference FPS | 8,22–10,27 / 4,63–6,09 |
| Callback → Pose / Hand p95 | 99,5–173,1 / 192,4–337,4 ms |
| CPU tổng Chrome | 196,5–228,8% một logical core |
| Private committed memory đầu lượt | 860,3 MiB |
| Private committed memory cuối mỗi cửa sổ | 836,8 / 830,1 / 851,8 / 837,3 / 827,6 MiB |

CDP báo cùng tám PID Chrome tại các đầu cửa sổ và phép đọc bộ nhớ Windows có đủ tám PID; PID ổn định ở hai đầu không loại trừ tiến trình sống ngắn. Working set đầu lượt là **1187,3 MiB**, các mốc cuối cửa sổ **1165,8 / 1163,6 / 1186,6 / 1173,5 / 1164,5 MiB**; working set có thể tính trùng trang chia sẻ. CPU bao gồm các tiến trình Chrome/UI/video, **100% tương ứng một logical core**, không gồm Vite hoặc mức dùng GPU vật lý. Các số bộ nhớ là snapshot, không phải đỉnh và không bao gồm đầy đủ GPU. Auto luôn ở trạng thái bình thường; 2/2 Worker đã đóng và camera track kết thúc khi dừng. Một lượt 150 giây không chứng minh không rò rỉ dài hạn, không xác nhận độ chính xác hoặc trải nghiệm webcam thật. Video, frame và landmark chỉ ở trong bộ nhớ browser; probe chỉ in thống kê tổng hợp.

Tái lập bằng production preview localhost: trong `frontend` chạy `npm run build` và `npx vite preview --host 127.0.0.1 --port 4267`; trong `e2e` đặt `TRACKING_BENCH_URL` tới `http://127.0.0.1:4267`, chạy `node tracking-autoscale-stress.cjs` để dùng camera giả Chromium hoặc thêm `"<video cục bộ>"` để dùng file. Với soak, chạy preview tại cổng 4270, đặt `TRACKING_BENCH_URL` tới `http://127.0.0.1:4270`, rồi chạy `node tracking-autoscale-soak.cjs "<video cục bộ>" 150 30`. Cả hai probe chặn truy cập ngoài localhost và không lưu video hay landmark.

## Thăm dò nhịp scheduler

Với mô phỏng callback đều 30 Hz trong 10 giây và giới hạn 24 FPS, scheduler hiện tại chọn 151 frame, còn prototype theo deadline chọn 241 frame, cả hai tính frame đầu. Scheduler hiện tại tính khoảng chờ từ callback được chọn gần nhất nên có thể bỏ lỡ nhịp trên nguồn đều; prototype cho phép một số khoảng cách ngắn hơn 1/24 giây để đạt nhịp trung bình gần giới hạn và đặt lại deadline sau khi ngừng lâu. Đây là mô phỏng, không phải FPS đo trên video hay trên camera.

Trong harness riêng không có UI hoặc overlay, cùng video 1080p phát 1×, Pose Lite CPU, Chrome headless 156, warm-up 3 giây media-time, cửa sổ đo media-time khoảng 8 giây và thứ tự hiện tại → prototype → prototype → hiện tại, scheduler hiện tại đạt **10,85 / 9,18 inference/s**, p95 inference **102,8 / 88,0 ms** và p95 khoảng cách giữa các callback được chọn **144,3 / 133,4 ms**. Prototype đạt **8,58 / 9,60 inference/s**, p95 inference **95,0 / 107,5 ms** và p95 khoảng cách giữa các callback được chọn **133,5 / 133,3 ms**. Scheduler hiện tại có **46,8 / 42,6 vòng rAF/s** và **55 / 72 long task** quan sát được; prototype có **39,7 / 42,1 vòng rAF/s** và **69 / 77 long task**. Các lượt xử lý frame khác nhau và tải nền chưa được kiểm soát; rAF của harness không phải FPS màn hình và long task có thể được báo muộn. Với các lượt ngắn này chưa có cải thiện nhất quán, nên scheduler mặc định chưa thay đổi; không thể suy ra độ chính xác, CPU/GPU/memory hoặc hiệu quả của UI từ harness. Khoảng cách callback không phải khoảng cách giữa kết quả hay độ trễ từ cảm biến tới màn hình.

Tái lập: chạy Vite ở cổng 4251, rồi chạy `node tracking-cadence-probe.cjs "<video cục bộ>" 2` trong `e2e`. Script chặn mạng ngoài localhost, chỉ in thống kê tổng hợp và không lưu video, frame hoặc landmark.

## Thử vòng đời lặp lại

Trên production preview, Chrome headless 156, `tracking-lifecycle-probe.cjs` chạy 8 chu kỳ main CPU và 8 chu kỳ Worker CPU, mỗi chu kỳ ít nhất một giây nhận diện trên video cục bộ. Probe quan sát 16/16 object URL được thu hồi, không còn callback video sau mỗi lần dừng, 8/8 Worker phát sự kiện đóng và không còn rAF, interval hoặc Worker theo bộ đếm sau unmount. Heap V8 sau GC qua 8 chu kỳ main tăng từ khoảng 5,06 lên 5,65 MB; qua các chu kỳ Worker tiếp theo từ 5,74 xuống 5,52 MB. Heap V8 không bao gồm toàn bộ WASM, GPU hay bộ nhớ trình duyệt, và thử nghiệm ngắn không chứng minh không có rò rỉ lâu dài.

Probe độc lập `tracking-model-lifecycle-probe.cjs`, không dùng video hay React, tái hiện mỗi lần tạo rồi đóng Pose Lite CPU giữ lại một thẻ script loader WASM và hai listener trong document: 8 lần tương ứng 8 script và 16 listener. Đây là quan sát với MediaPipe Tasks Vision 0.10.35 trong môi trường trên, không đủ định lượng tổng bộ nhớ bị giữ. Đối chứng canvas có listener rồi bỏ tham chiếu không có mức tăng tương tự. Cần kiểm tra vòng đời loader và kiểm thử lâu hơn trước khi kết luận.

Sau khi ứng dụng dọn script loader do từng lần khởi tạo tạo ra, chạy lại cùng 8 chu kỳ mỗi engine: số DOM node và listener sau mỗi chu kỳ giữ ở **459 / 223**, thay vì tăng qua các chu kỳ main như lượt trước; 16/16 URL được thu hồi, 8/8 Worker đóng và không còn callback video sau stop. Sau unmount, bộ đếm quan sát 0 rAF, interval và Worker. Heap V8 sau GC trong các chu kỳ main vẫn tăng khoảng **5,07 → 5,66 MB**, nên không thể kết luận việc dọn script đã giải quyết toàn bộ tăng bộ nhớ hoặc chứng minh không có rò rỉ. Helper chỉ dọn khi có `crypto.randomUUID` và URL loader chưa có fragment; kiểm thử hiện chủ yếu trên Chromium/CPU.

Probe độc lập `tracking-heap-probe.cjs` dùng canvas tổng hợp, không đọc video. Sau 50 lần tạo/đóng Pose Lite CPU với helper, không inference, V8 used heap sau GC tăng **1,78 → 3,77 MiB**, backing storage **0,62 → 15,71 MiB**, chưa thấy ổn định trong khoảng đo; WeakRef không còn model và số DOM node/listener/script ổn định. Sau 30 lần có inference, hai số tăng **1,79 → 3,04 MiB** và **0,62 → 9,55 MiB**. Đối chứng 30 lần chỉ tải/xóa loader hoặc một script tổng hợp cỡ 322 KB cũng cho backing storage tăng gần **0,62 → 9,53 MiB**; URL cố định và URL có fragment tương tự. Đối chứng script tổng hợp có used heap **1,38 → 1,42 MiB**. Đây là một lượt cho mỗi chế độ, không chứng minh nguyên nhân phần used heap tăng hay rò rỉ; cache source và instrumentation có thể góp phần, còn WeakRef không bao quát native/WASM/GPU. Tái lập với Vite cổng 4192, chạy `node tracking-heap-probe.cjs 50 owned-no-inference` và `node tracking-heap-probe.cjs 30 large-fixed` trong `e2e`.

Đối chứng `tracking-worker-memory-probe.cjs` chạy 12 chu kỳ Pose CPU trên canvas tổng hợp 320 × 240 trong Chrome headless: used heap V8 của isolate chính sau GC ở main tăng **2,382 → 2,956 MB**, còn Worker **1,256 → 1,281 MB**; 12/12 Worker đóng. Đây chỉ là isolate chính, không bao gồm heap Worker hoặc native/WASM/GPU, và các lượt có điều kiện/đường khởi tạo khác nhau; không chứng minh Worker dùng ít tổng bộ nhớ hoặc không rò rỉ. Tái lập trên Vite cổng 4203 với `node tracking-worker-memory-probe.cjs 12 main` và `node tracking-worker-memory-probe.cjs 12 worker` trong `e2e`.

Tái lập: chạy production preview tại `127.0.0.1:4188`, đặt `TRACKING_BENCH_URL` tương ứng và chạy `node tracking-lifecycle-probe.cjs "<video cục bộ>" 8 1000` hoặc `node tracking-model-lifecycle-probe.cjs 8` trong `e2e`. Các probe chỉ in số liệu tổng hợp.

## Kiểm tra camera vật lý

Một lượt smoke test khoảng 19:51 ngày 28-10-2026 (Asia/Bangkok; probe không ghi timestamp chính xác) dùng Chrome headless trên Windows, context tạm cho phép camera tại localhost và không dùng camera giả, mở **LGE Camera** ở 1280 × 720 với 30 FPS do thiết bị báo. Lab chạy Pose CPU khoảng 5 giây, ghi nhận 22,8 callback video/s, 13,9 inference/s, p50/p95 **25,3 / 50,0 ms** và 73,1 vòng render/s; track chuyển sang `ended` khi đóng nguồn. Lab báo **không thấy người** trong lượt này, nên không kiểm tra được độ chính xác landmark hay chuyển động phục hồi chức năng. Lượt đơn có tải nền không xác định, không dùng để so với benchmark video hoặc suy ra FPS màn hình và hiệu năng GPU. Probe không lưu frame, video hoặc landmark, chặn mạng ngoài localhost và không gọi database.

Tái lập khi người dùng sẵn sàng và cho phép camera: chạy bản build với preview tại `127.0.0.1:4198`, rồi chạy `node tracking-real-camera-probe.cjs` trong `e2e`. Script chỉ chọn camera có nhãn LGE Camera, dừng track và đóng context sau phép thử; quyền hệ điều hành vẫn phải cho phép thiết bị.
