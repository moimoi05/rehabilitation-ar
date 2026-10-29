# Danh sách kiểm thử thủ công

Thực hiện trên laptop và TV dự kiến sử dụng, với dữ liệu giả lập. Không suy luận hiệu quả lâm sàng từ các bước kiểm thử này.

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

- [ ] Ghi video, AI FMA-UE và đề xuất cá nhân hóa được hiển thị là chưa triển khai; không có kết quả y khoa giả.
- [ ] Không dùng thông tin định danh thật trong lần kiểm thử này.
