# RTMPose WholeBody thử nghiệm trên Intel GPU

Dịch vụ độc lập với FastAPI/DB, chỉ nghe `127.0.0.1:8766`. Không dùng CUDA,
không tự chuyển sang CPU, không sửa driver. Model medium chính thức là bản
distilled `c8b76419_20230728`, khác checkpoint `cd5e845c` tháng 1/2023.

Từ thư mục repository, PowerShell:

```powershell
python -m venv scratch/rtmpose-runtime/.venv
scratch/rtmpose-runtime/.venv/Scripts/python.exe -m pip install -r scratch/rtmpose-runtime/requirements.txt
python scratch/rtmpose-runtime/setup_models.py
scratch/rtmpose-runtime/.venv/Scripts/python.exe scratch/rtmpose-runtime/service.py
```

Giữ terminal dịch vụ mở; `Ctrl+C` để dừng. Không chạy hai bản dịch vụ.
Bản v2 khóa cổng bằng SO_EXCLUSIVEADDRUSE trên Windows; `/info` phải có
`serviceVersion: rtmpose-gpu-v2`. Frontend từ chối bản dịch vụ cũ.
`/info` chỉ báo sẵn sàng sau khi compile và thực thi tensor kiểm tra trên GPU;
`executionDevices` phải chỉ có GPU. `/drain` chờ request cũ kết thúc trước khi
khởi tạo engine khác. File model/data nằm trong `rehab-data/` và không commit.
Script setup chỉ lấy ONNX và metadata từ hai SDK OpenMMLab, kiểm tra SHA-256,
không giải nén/chạy binary đi kèm; Large không được tải.

Khởi động FE/BE bằng launcher sẵn có, mở Edge:
`http://127.0.0.1:5173/tracking-benchmark`. Chạy MediaPipe → RTMPose ROI →
RTMPose + RTMDet tuần tự, video 1×, warm-up 3 giây. Đưa tab ra tiền cảnh và
giữ hiển thị trong cả lượt. Không chạy inference khác khi đo. ROI là thiết lập
một người, cần xác nhận thủ công; kiểm tra biên/độ tin cậy không chứng minh
được mọi trường hợp người ra ngoài ROI. Detector từ chối 0 hoặc nhiều người.

Tại calibration hoặc Tracking Test Lab, chọn model và xác nhận ROI rồi bắt đầu.
Tọa độ RTMPose chỉ có 2D; capture MediaPipe z/world bị chặn. Mirror không đổi
nhãn giải phẫu. `http://127.0.0.1:5173/rtmpose-probe.html` là probe WebGPU
synthetic riêng, không phải benchmark video; dùng batch cố định và cấm CPU EP.

Benchmark sử dụng API artifact hiện có; không ghi phiên bệnh nhân. Mỗi run
hoàn chỉnh cần sáu file theo báo cáo. `COMPLETE` xác nhận artifact, không tự
chứng minh điều kiện đo công bằng hay độ chính xác lâm sàng. Xem báo cáo
`docs/MEDIAPIPE_VS_RTMPOSE_WHOLEBODY_REPORT.md` để biết giới hạn kết luận.

Telemetry tùy chọn, chạy một lần xuyên suốt các cấu hình:

```powershell
pwsh -NoProfile -File scratch/rtmpose-runtime/telemetry.ps1 -OutputDirectory rehab-data/benchmarks/MY-UNIQUE-host-telemetry -DurationSeconds 180
```

Đây là counter toàn máy; nhiệt độ die và công suất không được suy đoán từ
thermal-zone hoặc utilization. Báo N/A khi hệ điều hành không cung cấp.
