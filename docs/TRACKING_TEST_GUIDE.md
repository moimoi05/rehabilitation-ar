# Hướng dẫn kiểm thử tracking

## Video cục bộ

1. Chạy frontend theo README của dự án, mở Camera & hiệu chuẩn và chọn **Mở Tracking Test Lab** (hoặc mở `/tracking-lab`).
2. Chọn video MP4 bằng bộ chọn file. Video được mở bằng object URL trong trình duyệt; không cần đưa file vào `public`, cơ sở dữ liệu hoặc tải lên. Chờ metadata và nhấn Phát nếu trình duyệt không tự phát.
3. Chọn profile, Pose hoặc Hand và delegate trước khi bắt đầu nhận diện. CPU là mặc định; tùy chọn thử GPU có fallback CPU. Kiểm tra trạng thái model và delegate thực tế.
4. Cho model chạy ổn định vài giây, nhấn **Bắt đầu đo**. Chạy cùng đoạn, tốc độ phát, profile và cấu hình cho mỗi phép so sánh; nhấn **Dừng đo**, rồi **Xuất benchmark JSON**. FPS nguồn là frame callback quan sát được, không phải tổng frame được giải mã; frame bị bỏ trong lúc main thread bận có thể không được đếm.
5. Chuyển Smoothed để so với Raw, quan sát chuyển động chậm và nhanh, mất người, che khuất, pause/resume, seek và phát lại từ đầu. Không xem độ ổn định là độ chính xác tuyệt đối khi không có ground truth. Kiểm tra cả chậm bám khi tay chuyển động.
6. Đóng nguồn hoặc rời trang để dừng model, camera và giải phóng object URL. Không lưu video riêng tư trong Git hoặc ảnh trace khi không cần thiết.

`resultAgeMs` trong JSON và tuổi kết quả trong Lab tính từ timestamp callback video dùng cho lần suy luận mới nhất, đã điều chỉnh tăng đơn điệu. Đây không phải thời điểm cảm biến camera ghi hình hay độ trễ từ chuyển động tới màn hình. Với Worker, ImageBitmap được tạo sau callback và không nhất thiết là chính frame được metadata callback mô tả. Thời gian Worker từ callback đến kết quả cũng bao gồm việc tạo và truyền ảnh.

## Webcam và hiệu chuẩn

Trong Lab chọn **Bật camera**, cho phép quyền và kiểm tra mốc, phản chiếu cùng độ phản hồi. Trong Camera & hiệu chuẩn kiểm tra Ghost, đổi kích thước cửa sổ, toàn màn hình, hai trạng thái lật ảnh và chọn đúng tay ảnh hưởng. Sau khi thay đổi nguồn hoặc hiệu chuẩn, chuyên viên cần xác nhận tư thế lại. Chế độ demo là dữ liệu mô phỏng, không phải bệnh nhân.

Khi bật cả Pose và Hand, nếu Hand lỗi trong lúc suy luận trên luồng chính hoặc Worker, hệ thống xóa mốc Hand, báo lỗi và tiếp tục Pose. Trong Lab, phép đo đang chạy dừng trước khi cấu hình thay đổi; bắt đầu phép đo mới để đo Pose riêng. Nếu chỉ bật Hand, lỗi suy luận sẽ dừng nhận diện. Lỗi Pose hoặc Worker tổng thể vẫn dùng nhánh dừng hoặc fallback hiện có. Muốn thử lại Hand, dừng rồi khởi động lại nhận diện.

Trong Settings hoặc Camera & hiệu chuẩn, **Dùng độ phân giải camera theo cấu hình tracking** là lựa chọn có chủ ý, mặc định tắt để giữ thiết lập thủ công. Ở Workspace cần đóng camera trước khi đổi lựa chọn. Khi bật, profile yêu cầu kích thước camera tương ứng; thiết bị có thể thương lượng kích thước khác. Thiết lập thủ công được giữ lại khi tắt tùy chọn. Kiểm tra kích thước thực, khung hình và xác nhận lại hiệu chuẩn sau khi bật camera. Thay đổi độ phân giải có thể thay đổi kết quả landmark; phép thử resize thăm dò trong benchmark chưa chứng minh tính tương đương về độ chính xác.

Trong phiên camera, Ghost được neo tương đối với vùng ảnh khi thay đổi bố cục hoặc mirror. Hệ thống bỏ xác nhận khi hình học thay đổi; nếu Ghost ra ngoài phạm vi hiệu chuẩn, hãy căn lại trước khi xác nhận hoặc lưu. Với backend và schema hỗ trợ, bản ghi mới có thể kèm neo theo ảnh phiên bản 1; khi khôi phục, neo chỉ được áp dụng nếu ID camera và kích thước thực trùng. Khi không đủ thông tin hoặc không có hỗ trợ, ứng dụng dùng tọa độ theo khung và báo cần căn chỉnh lại. Bản ghi cũ giữ nguyên tọa độ theo khung. Trong mọi trường hợp, sau khi khôi phục cần kiểm tra camera, khung hình và xác nhận lại; cùng camera và kích thước không bảo đảm camera chưa di chuyển.

Backend mới kiểm tra hỗ trợ qua `GET /api/capabilities` và vẫn đọc/lưu hiệu chuẩn theo định dạng cũ khi database chưa có cột neo. Để lưu neo theo ảnh, schema cần migration `948b1ad2a337` (xem quy trình Alembic trong README). Migration bổ sung cột nullable và không thay đổi dữ liệu cũ; nó không được tự chạy. Khi nâng cấp một database hiện có, người vận hành cần kiểm tra đúng database và quy trình sao lưu trước khi áp dụng migration. Nếu frontend không xác nhận được capability, nó chỉ gửi tọa độ cũ và không tự gửi lại POST.

Thử từ chối quyền camera, ngắt camera, tải model thất bại và khởi động lại. Ghost và hiệu chuẩn thủ công cần tiếp tục dùng được khi nhận diện lỗi. Thử chạy lâu để quan sát bộ nhớ và phản hồi UI bằng công cụ trình duyệt; CPU/GPU/memory phụ thuộc thiết bị và không suy ra từ FPS.

## Kiểm thử tự động

Frontend: `cd frontend; npm run typecheck`, `npm run lint`, `npm run build`. Thư mục `e2e/` đã được dọn bỏ để giữ repository tối giản; không chạy Playwright hay probe giả lập. Camera giả và Chrome headless không thay thế kiểm tra webcam, GPU và lâm sàng trên laptop thật.

Trong lượt xác minh cuối sau thay đổi neo ảnh, frontend đạt **247/247** kiểm thử trên 25 file, coverage dòng V8 **95,52%** và production build đạt. Backend trước đó đạt **5/5** kiểm thử tích hợp trên PostgreSQL 16 tạm. Sau thay đổi neo ảnh, PostgreSQL 18 tạm biệt lập đạt **4/4** kiểm thử schema cũ và **29/29** kiểm thử sau migration; cơ sở dữ liệu hiện có và `.env` của dự án không bị thay đổi. Có một cảnh báo deprecation của Starlette/httpx. Các kiểm thử này không chứng minh độ chính xác lâm sàng.

## Worker CPU thử nghiệm trong Workspace

Worker không bật mặc định. Tại Settings hoặc Camera & hiệu chuẩn chọn **Sử dụng Worker CPU (thử nghiệm)**; trong Workspace cần dừng nhận diện trước khi đổi lựa chọn. Lựa chọn được lưu trong Settings, và trạng thái hiển thị engine thực tế. Khi Worker không hỗ trợ, lỗi hoặc timeout, ứng dụng thử lại trên main thread và hiển thị thông báo. Trong Lab có thể chọn **Worker CPU (thử nghiệm)** trước khi khởi động. Chế độ chỉ Hand dùng main thread; khi Worker lỗi, phép đo dừng trước khi fallback. Thời gian model và thời gian callback đến kết quả được hiển thị riêng. Kiểm tra webcam và độ phản hồi thực tế trước khi sử dụng.

Để thử hai Worker trong Lab, bật cả **Pose** và **Hand (21 mốc)**, chọn **Hai Worker CPU (thử nghiệm)** rồi bắt đầu nhận diện. Đợi cả hai model sẵn sàng trước khi warm-up và đo; Hand có thể mất tới khoảng 20 giây để báo timeout. Nếu Hand không khởi tạo được hoặc lỗi trong lúc chạy, Lab báo lỗi, xóa mốc Hand và tiếp tục Pose; phép đo đang chạy dừng trước khi cấu hình thay đổi. Nếu Pose Worker lỗi hoặc không khởi tạo, Lab dừng phép đo và thử CPU trên main thread. Dừng nhận diện hoặc đổi nguồn sẽ hủy các Worker.

Để thử trong Camera & hiệu chuẩn, dừng nhận diện, bật **Theo dõi 21 mốc bàn tay**, chọn **Sử dụng hai Worker CPU (thử nghiệm)** và khởi động lại. Chỉ báo engine cho biết hệ thống đang dùng hai Worker, Worker Pose sau lỗi Hand, hay CPU trên luồng chính sau fallback. Lựa chọn hai Worker chỉ áp dụng trong lần mở trang hiện tại và không được lưu vào Settings; lựa chọn một Worker đã lưu được giữ nguyên và tạm không áp dụng trong khi chọn hai Worker. Nếu Hand lỗi, mốc Hand bị xóa và Pose tiếp tục; dừng rồi khởi động lại để thử Hand. Hai luồng chụp ảnh độc lập và có thể xử lý frame khác nhau. Kiểm tra Ghost, trạng thái mốc, các thao tác UI và đóng nguồn; kết quả benchmark Lab không chứng minh hiệu năng của Workspace.

Người dùng đã tự thử và báo cảm nhận hai Worker mượt hơn. Đây là nhận xét trải nghiệm, không phải phép đo FPS, độ trễ hay độ chính xác; hãy so sánh lại với Auto và cấu hình cố định trên máy, nguồn video và chuyển động thực tế dự định sử dụng.

Khi chọn hai Worker trong Workspace, **Tự điều chỉnh nhịp hai Worker (thử nghiệm)** được bật sẵn; có thể tắt trước khi khởi động để so sánh với profile cố định. Trong Lab, bật **Tự điều chỉnh nhịp Worker** riêng sau khi chọn hai Worker. Auto bắt đầu với trần Pose 30 / Hand 20 FPS và có thể giảm khi phản hồi giao diện chịu áp lực kéo dài, sau đó phục hồi chậm. Xem trạng thái và giới hạn hiện tại trên màn hình; chúng không phải FPS inference thực. Trình duyệt không đo được tổng CPU máy cho bộ điều chỉnh, nên không thể cam kết còn lại một tỷ lệ CPU hoặc tránh mọi tình huống quá tải. Nếu theo dõi hoặc thao tác UI kém hơn trên máy thực, dừng nhận diện và thử cấu hình cố định.

Lab có lựa chọn làm mượt **Đáp ứng nhanh (thử nghiệm)** để so sánh với **Tiêu chuẩn** hoặc Raw; cấu hình được khóa trong phép đo và lưu trong JSON benchmark. Đáp ứng nhanh có thể giữ nhiều dao động hơn và chỉ áp dụng cho bản hiển thị Pose; chưa được xác nhận cho vận động phục hồi chức năng.

Ở chế độ hai Worker, xem các chỉ số Pose và Hand riêng trong UI hoặc JSON (`dualPose`, `dualHand`). Các trường inference chung trong JSON và UI mô tả Pose; thời gian callback đến kết quả bao gồm tạo và chuyển bitmap. Số frame bị giới hạn của Hand bao gồm giới hạn scheduler chung và giới hạn tần suất Hand; frame Worker bận được đếm riêng. Tuổi tính từ callback video, không phải thời điểm cảm biến chụp hay độ trễ chuyển động đến màn hình. Hai Worker chụp ảnh độc lập nên kết quả có thể thuộc những frame khác nhau; không cộng các giá trị p95 để suy ra thời gian tổng.

Phép căn chỉnh hỗ trợ `object-fit: fill`, `contain` và `cover` khi ảnh ở giữa khung. Kiểm thử trình duyệt dùng video cục bộ ép khung vuông, đổi các chế độ và mirror; kiểm thử fullscreen dùng camera giả. Trong trò chơi, nếu crop hoặc hình học khung thay đổi, điểm và thời gian tạm dừng cho đến khi có chuyển động cổ tay thô đủ để xác nhận người chơi đã di chuyển; không coi việc đổi crop là chuyển động bệnh nhân. Người hướng dẫn cũng có thể chọn **Tiếp tục sau khi kiểm tra** khi mốc cổ tay đang đáng tin cậy. Ngưỡng mở khóa tự động là 1,3 lần bán kính hoa, tương đương 9,1% chiều cao khung hiển thị; với người có biên độ hạn chế, người hướng dẫn có thể kiểm tra và chọn nút tiếp tục. Trò chơi đợi quan sát mới được ghi sau xác nhận; yêu cầu hết hạn hoặc bị hủy khi mất mốc, khoảng gián đoạn quan sát quá 500 ms hoặc đổi khung, và cổ tay đang đứng trên hoa không tự tạo lượt chạm.

Trong Workspace chọn đúng tay ảnh hưởng và kiểm tra thông báo vai/khuỷu/cổ tay; nếu một mốc ngoài ảnh hoặc visibility thấp, hệ thống báo chưa đáng tin cậy. Đưa cả chi trên vào khung, kiểm tra tình trạng Hand riêng trong Lab và xác minh mốc biến mất khi che khuất hoặc ngắt nguồn. Các chỉ báo là đầu ra model, không chứng minh vị trí đúng về mặt lâm sàng.
