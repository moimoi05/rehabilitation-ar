# Danh sách kiểm thử thủ công

Thực hiện trên laptop và TV dự kiến sử dụng, với dữ liệu giả lập. Không suy luận hiệu quả lâm sàng từ các bước kiểm thử này.

Các ô dưới đây dành cho kiểm tra trực tiếp trên thiết bị; không đánh dấu đạt chỉ từ unit test hoặc camera giả lập. Bằng chứng tự động được ghi riêng trong `IMPLEMENTATION_REPORT.md`.

## Năm phân hệ và hồ sơ

- [ ] Menu chính chỉ có Tổng quan, Đánh giá, Luyện tập, Báo cáo, Quản trị; các URL cũ vẫn mở được.
- [ ] Tổng quan hiển thị bốn số liệu từ PostgreSQL. Tạo lượt khám/buổi tập và kiểm tra số liệu, hoạt động gần đây cập nhật thật.
- [ ] Quản trị có hai nhóm. Tạo mã duy nhất, thử mã trùng, tìm theo mã/tên, sửa hồ sơ tùy chọn và xóa liên hệ/ghi chú nếu cần.
- [ ] Đối chiếu CSV/API các hồ sơ cũ cần phân loại lại; không tự suy đoán từ lịch sử training cũ.

## Đánh giá, Baseline và chuyển nhóm

- [ ] Chọn bệnh nhân đến khám cũ và tạo hai lần đánh giá khác nhau; xác nhận lần mới không ghi đè lịch sử.
- [ ] Thử đủ text, number, date, single/multiple choice, boolean, trường bắt buộc, thứ tự và lỗi dữ liệu.
- [ ] Tạo phiên bản bộ câu hỏi mới trong Quản trị; báo cáo cũ giữ nhãn/nội dung/câu trả lời snapshot.
- [ ] Bật camera/landmarks/hình bóng, nhân viên kiểm tra đầu, vai, thân và lưu hiệu chuẩn; thiếu bước không được bắt đầu.
- [ ] Chọn nhiều bài, chạy nhiều lượt cùng lần khám; UUID và trial riêng, kết quả đúng bài.
- [ ] Ngắt mạng lúc lưu rồi thử lại; không có kết quả trùng. Lượt không có thời gian theo dõi chỉ được hủy, không lưu kết quả giả.
- [ ] Nhập FMA-UE chuyên môn 0–66 và tên người xác nhận; thiếu xác nhận phải bị chặn. Điểm game không tự chuyển thành FMA-UE.
- [ ] Hoàn tất rồi chuyển nhóm từ kết quả; làm tương tự từ Quản trị. Chọn Baseline hoàn thành đúng bệnh nhân, không tạo bệnh nhân mới.
- [ ] Sau chuyển, hồ sơ biến khỏi nhóm đến khám, xuất hiện trong nhóm điều trị; Baseline và các lần khám vẫn mở được.
- [ ] Thử chuyển lại khi đã thuộc nhóm đích; có thông báo rõ, số sự kiện chuyển nhóm không tăng.
- [ ] Thiếu Baseline bị chặn mặc định. Chỉ khi có policy ngoại lệ, nhập lý do và xác nhận mới được chuyển; kiểm tra audit.

## Luyện tập hằng ngày

- [ ] Tìm chính xác mã inpatient; mã không tồn tại cho nhập lại; outpatient được hướng dẫn sang Đánh giá và không tạo được training.
- [ ] Dashboard có tuổi, tay, ngày nhập viện, Baseline, lịch sử, trial và biểu đồ thời lượng thật.
- [ ] Hái hoa xuất hiện mặc định; bài bổ sung chỉ xuất hiện khi có chỉ định còn hiệu lực. Ngừng chỉ định và kiểm tra không mở được lượt mới cho bài đó.
- [ ] Bắt đầu buổi draft, setup một lần, lưu calibration rồi in_progress. Chơi hai bài, tiếp tục về dashboard; không tạo session mới hoặc mở lại camera giữa hai lượt.
- [ ] Biểu đồ/lịch sử cập nhật sau mỗi kết quả. Xem từng game và lọc khoảng ngày; không so thang điểm game khác nhau.
- [ ] Di chuyển ghế/người bệnh: dùng Kiểm tra lại ghế và tư thế. Đổi camera/gương/khôi phục cấu hình: xác nhận cũ bị hủy, chặn chơi đến khi kiểm tra và lưu lại.
- [ ] Dừng tracking giữa lượt hoặc nhận phản hồi lưu/calibration chậm; không dùng cấu hình cũ hoặc tạo lượt bị kẹt.
- [ ] Chọn Trở về, hủy xác nhận: giữ buổi/camera. Xác nhận lần sau: completed, ended_at, giải phóng camera/MediaPipe/Workers và về màn hình tìm.
- [ ] Đóng tab/mất kết nối: kết quả đã lưu còn nguyên, buổi dang dở, trial chưa xong không có kết quả giả. Khi vào lại, nhận biết và đóng buổi dang dở với xác nhận.

## Báo cáo

- [ ] Xem assessment/Baseline sau nhập viện và báo cáo training; câu hỏi snapshot, FMA xác nhận, số lượt/thời lượng đúng bản ghi.
- [ ] Lọc bệnh nhân, ngày, game, buổi; thử gần nửa đêm để xác nhận ngày bệnh viện UTC+7 khớp biểu đồ/bộ lọc.
- [ ] Khi hồ sơ đổi tay bị ảnh hưởng, báo cáo cũ vẫn ghi bên tay của session lúc thực hiện.
- [ ] Video/artifact chỉ có link khi capture thật của đúng trial đã hoàn tất; metadata thiếu/lỗi không được hiển thị như video đã ghi thành công.

## Khởi động và dữ liệu

- [ ] Làm theo README, khởi động PostgreSQL, áp dụng migration và mở frontend.
- [ ] Health báo backend và database đang hoạt động. Dừng backend để xác nhận giao diện hiển thị lỗi rõ ràng, sau đó khởi động lại.
- [ ] Tạo một bệnh nhân chỉ bằng mã nghiên cứu giả danh; thử mã trùng hoặc dữ liệu không hợp lệ và xác nhận lỗi dễ hiểu.
- [ ] Mở, sửa thông tin bệnh nhân; tạo phiên đánh giá hoặc luyện tập, chọn tay và kiểm tra danh sách/chi tiết.
- [ ] Kiểm tra dashboard và danh sách phiên phản ánh dữ liệu thực sự vừa tạo.

## Demo và hiệu chuẩn

- [ ] Mở Workspace ở chế độ demo, không cấp quyền camera; xác nhận có nhãn **DEMO — KHÔNG PHẢI DỮ LIỆU BỆNH NHÂN**.
- [ ] Bật/tắt hình bóng; điều chỉnh độ trong suốt, vị trí, tỷ lệ và bên tay. Xác nhận đầu, vai, thân, đường giữa và đường vai dễ nhìn.
- [ ] Thử toàn màn hình trên TV và đổi kích thước cửa sổ; kiểm tra video, hình bóng và skeleton không lệch tỷ lệ hoặc hướng.
- [ ] Xác nhận dữ liệu demo không trở thành bản ghi hiệu chuẩn bệnh nhân.
- [ ] Trong phiên thật dùng dữ liệu giả lập, bật camera và chọn thiết bị. Điều chỉnh ghế và hình bóng, nhân viên xác nhận thủ công rồi lưu.
- [ ] Thay đổi cấu hình; khôi phục cấu hình đã lưu và kiểm tra cấu hình đúng phiên. Hệ thống yêu cầu kiểm tra camera, tư thế và xác nhận lại sau khi khôi phục.
- [ ] Di chuyển ghế hoặc camera; hiệu chuẩn lại và xác nhận thủ công. Không coi hình bóng là xác nhận lâm sàng tự động.

## Camera và MediaPipe

- [ ] Từ chối quyền camera rồi kiểm tra hướng dẫn cấp quyền; cấp lại quyền trong trình duyệt và thử lại.
- [ ] Nếu có nhiều camera, chọn lần lượt các thiết bị; thử độ phân giải, lật ngang và toàn màn hình.
- [ ] Bật nhận diện Pose, đưa vai/khuỷu/cổ tay vào khung; kiểm tra skeleton, FPS và trạng thái. Che camera hoặc rời khung để xác nhận trạng thái mất người.
- [ ] Bật nhận diện Hand, đưa bàn tay vào và ra khỏi khung; kiểm tra các mốc và trạng thái mất tay. Tắt skeleton và xác nhận video vẫn hoạt động.
- [ ] Kiểm tra tải lỗi model hoặc thiếu mạng nếu áp dụng; hiệu chuẩn thủ công phải tiếp tục dùng được.
- [ ] Tắt camera hoặc rời trang; xác nhận đèn camera tắt và có thể mở lại. Ghi nhận FPS, cấu hình máy, trình duyệt, độ phân giải và lỗi quan sát được; không giả định 30 FPS.

## Chạm hoa phát sáng

- [ ] Bật demo, nhấn **Bắt đầu trò chơi**, di chuyển chuột hoặc chạm vào hoa và rời hoa trước lần tiếp theo. Kiểm tra bộ đếm và thời gian dừng khi không có con trỏ; kết quả demo không có nút lưu.
- [ ] Với dữ liệu giả lập và camera, chuyển phiên sang **Đang thực hiện**, bật nhận diện và nhân viên xác nhận tư thế. Kiểm tra không bắt đầu được nếu thiếu điều kiện.
- [ ] Đưa cổ tay bên tập vào hoa, rời hoa rồi chạm lại. Che cổ tay hoặc làm mất mốc và kiểm tra đồng hồ tạm dừng; tiếp tục khi mốc trở lại. Thử gương và cả hai bên tay.
- [ ] Dừng sớm hoặc hoàn thành 30 giây có theo dõi, xác nhận lưu và mở **Kết quả & báo cáo → Xem trò chơi** tại phiên. Kiểm tra tay tập, thời lượng và số hoa, sau đó kiểm tra việc thử lưu lại khi mất kết nối không tạo lượt trùng.
- [ ] Trong một lượt chưa lưu, thay đổi phiên, tay, gương hoặc camera và kiểm tra lượt được hủy. Nếu điều kiện thay đổi trong khi đang lưu, kiểm tra trang kết quả trước khi tạo lượt khác vì yêu cầu có thể đã hoàn tất.
- [ ] Kiểm tra trò chơi hiển thị số hoa là kết quả trò chơi, không phải FMA-UE hay kết luận lâm sàng. Dừng khi người tham gia cảm thấy khó chịu.

## Giới hạn

- [ ] AI FMA-UE và đề xuất cá nhân hóa được hiển thị là chưa triển khai; không có kết quả y khoa giả.
- [ ] Không dùng thông tin định danh thật trong lần kiểm thử này.

## Thu thập và replay video

Các mục dưới đây là quy trình kiểm thử, không phải xác nhận rằng các bước đã được thực hiện. Ghi riêng kết quả thực tế, cấu hình, capture ID, số frame/landmark và lỗi; không đính kèm video hoặc landmark vào Git.

- [ ] Tạo bệnh nhân giả danh, phiên và trial liên quan; kiểm tra từ chối liên kết không khớp. Chỉ bật loại artifact có đồng ý tương ứng.
- [ ] Chọn video cục bộ tại Tracking Test Lab, không bật camera; kiểm tra phát, độ phân giải, Pose, Hand nếu bật và trạng thái model. Phân biệt nguồn `pre_recorded_video` với webcam.
- [ ] Với video replay, xác nhận không yêu cầu quyền webcam; kiểm tra video gốc không bị thay đổi và không nằm trong `frontend/public`. Video được lưu phải là file nguồn chứ không phải bản ghi MediaRecorder giả lập.
- [ ] Sau khi thu và dừng, kiểm tra trạng thái từng artifact; lấy file qua API, đối chiếu checksum và đọc Parquet. Đối chiếu `capture_id`, frame ID, timestamp và media time, cả frame không detection và frame bỏ qua nếu có.
- [ ] Kiểm tra raw không bị thay bằng display smoothing; phân biệt normalized/world và xác nhận validity, visibility, presence, handedness chỉ theo dữ liệu thực tế được cung cấp.
- [ ] Kiểm tra lỗi upload, mất backend và chunk/batch thiếu; trạng thái không được báo hoàn tất sai, dữ liệu staging đã nhận được giữ lại. Kiểm tra thử gửi lại cùng dữ liệu không gây trùng.
- [ ] Khi có điều kiện webcam, thử riêng chức năng ghi camera gốc không overlay, đồng ý, dừng chờ chunk cuối, kiểm tra file và cleanup. Không kết luận đã kiểm thử webcam chỉ từ replay hoặc fake camera.
- [ ] Khi replay bị seek/phát lại, kiểm tra việc ngăn trộn timestamp hoặc reset model và capture; ghi lại độ sai lệch đồng bộ nếu đo được.
