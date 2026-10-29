# Kiểm thử giao diện đầu cuối

Bộ kiểm thử dành cho môi trường phát triển với cơ sở dữ liệu PostgreSQL riêng chứa dữ liệu giả lập. Các phép thử tạo thêm hồ sơ, phiên và hiệu chuẩn thử nghiệm; chúng không tự xóa dữ liệu. Không chạy với cơ sở dữ liệu nghiên cứu thật.

Khởi động PostgreSQL, migration, backend trên `127.0.0.1:8001` và frontend trên `127.0.0.1:5173` theo README gốc. Sau đó:

```powershell
cd e2e
npm ci
npm test
```

`E2E_BASE_URL` và `E2E_API_BASE_URL` có thể thay đổi địa chỉ frontend và API. Chromium dùng Chrome đã cài đặt với thiết bị camera giả của trình duyệt; kết quả không chứng minh khả năng hoạt động với webcam hay bệnh nhân thật. Ảnh và trace khi lỗi nằm trong `test-results/`. Chạy lại có thể thay thế ảnh của lần trước.
