# MediaPipe và RTMPose WholeBody trên LG Gram

Ngày đánh giá: **01/11/2026**. Ba lượt đối chứng cuối đã hoàn tất, đủ sáu artifacts bắt buộc. **MediaPipe Pose/Hand và RTMPose-m đều chạy neural inference trên Intel Iris Xe, không CPU fallback trong đối chứng.** RTMPose graph inference nhanh nhưng pipeline localhost chậm hơn; chưa chứng minh ưu thế lặp lại để thay mặc định MediaPipe. Giữ hai engine có thể chọn, RTMPose vẫn thử nghiệm.

Số đo chính lấy từ **bộ v2 13:01UTC** ở mụcH, không lấy từ synthetic, diagnostic cũ hoặc lượt xác nhận tài nguyên nhiều giờ sau. Không thay FMA-UE, DB, workflow bệnh nhân hoặc model MediaPipe.

## A. Kiến trúc và nguồn model

MediaPipe Tasks Vision **0.10.35** dùng Pose Landmarker Lite và Hand Landmarker riêng (`VIDEO`, hai tay), có phát hiện/track nội bộ. RTMPose WholeBody dùng CSPNeXt/RTMCCHead và SimCC, là **top-down**, cần vùng người trước inference. WholeBody trả 133 điểm 2D gồm thân, chân, mặt và hai bàn tay; ứng dụng chỉ map các điểm có nghĩa tương thích. Không có MediaPipe world coordinates hoặc z.

Medium dùng **H×W = 256×192**, SimCC split ratio 2.0, `normalize=False`, `use_dark=False`. Chuẩn hóa RGB mean `[123.675,116.28,103.53]`, std `[58.395,57.12,57.375]`. Decode argmax x/y rồi chia 2; score là `min(max_x,max_y)`, không phải visibility probability. [Cấu hình chính thức](https://github.com/open-mmlab/mmpose/blob/main/configs/wholebody_2d_keypoint/rtmpose/coco-wholebody/rtmpose-m_8xb64-270e_coco-wholebody-256x192.py), [SimCC decode](https://github.com/open-mmlab/mmpose/blob/main/mmpose/codecs/utils/post_processing.py).

Đã dùng ONNX SDK **distilled DWPose Medium tháng 7/2023**, `rtmpose-m_simcc-ucoco_dw-ucoco_270e-256x192-c8b76419_20230728`, liên kết bởi [project RTMPose chính thức](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose). Đây không phải checkpoint January `cd5e845c` trong [model-index](https://github.com/open-mmlab/mmpose/blob/main/configs/wholebody_2d_keypoint/rtmpose/coco-wholebody/rtmpose_coco-wholebody.yml); không trộn AP/kết quả hai bản.

| Tài sản | Nguồn và toàn vẹn |
|---|---|
| Pose SDK | [ZIP OpenMMLab](https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-ucoco_dw-ucoco_270e-256x192-c8b76419_20230728.zip), 66.976.066 byte; server MD5 `3a5b8b0bc65b02a3419e7ced1f0106e3` |
| ONNX pose thực thi | SHA-256 `94ca58fa2d6c4530b6957ac9548084ebc2fa27ed71e4e01f0b73844306ed01a6` |
| Detector | RTMDet-nano `rtmdet_nano_8xb32-300e_coco-person_in1kpretrain-96154d0b`, input 320×320, từ [SDK OpenMMLab](https://download.openmmlab.com/mmpose/v1/projects/rtmpose/rtmpose-cpu.zip) |
| ONNX detector thực thi | SHA-256 `b8585adb6d1352796f6e86337e09c3459b830645a7e7192d9381670bea2facbd` |

Mã MMPose có [Apache-2.0](https://github.com/open-mmlab/mmpose/blob/main/LICENSE). Giữ provenance/checksum/license cùng tài sản cục bộ; giấy phép mã nguồn không thay mọi điều kiện dữ liệu huấn luyện/checkpoint. MD5 kiểm tra toàn vẹn, không phải chữ ký. [Export MMDeploy](https://github.com/open-mmlab/mmpose/blob/main/docs/en/user_guides/how_to_deploy.md).

Chưa tải/chạy RTMPose-l 384×288: Medium đã bộc lộ chi phí truyền ảnh và vấn đề ROI; chưa có bằng chứng lợi ích lặp lại để biện minh tải thêm Large. Không coi AP COCO là độ chính xác lâm sàng.

## B. Runtime và xác minh GPU

Máy ghi nhận i5-1340P, RAM16.880.881.664byte, Iris Xe, driver **31.0.101.3962**, Edge **156**. `Win32_OperatingSystem.Caption` xác nhận **Microsoft Windows11 Home Single Language**, version10.0.26200. Hardware API cũ đọc registry ProductName trả Windows10 là chuỗi tương thích; giữ raw metadata và ghi chú khác biệt, không coi đó là OS thực khác. Video/inference đều cục bộ, không CUDA, không chỉnh driver, không truy cập RTX4090.

| Engine | Bằng chứng thiết bị inference | CPU fallback |
|---|---|---|
| MediaPipe Pose | Delegate GPU; renderer lấy từ **canvas thực sự truyền vào task Pose**: `ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x0000A7A0) Direct3D11 ... D3D11)` | Không |
| MediaPipe Hand | Delegate GPU; renderer lấy độc lập từ **canvas thực sự truyền vào task Hand**, cùng Iris Xe | Không |
| RTMPose-m | OpenVINO **2026.4.1**, `Intel(R) Iris(R) Xe Graphics (iGPU)`, `executionDevices=[GPU.0]`, `gpuVerified=true` | Không |
| RTMDet-nano | Compile/inference OpenVINO GPU; detector timing riêng trong lượt detector, có tính vào tổng pipeline | Không |

Đây là neural inference GPU, không suy từ overlay WebGL. Preprocessing, JPEG encode/decode, SimCC decode, serialization, HTTP và render vẫn có phần CPU; không gọi toàn pipeline là GPU-only.

Đã khảo sát **ONNX Runtime Web WebGPU trước**. Strict `disable_cpu_ep_fallback=1` ban đầu từ chối dynamic batch; cố định `freeDimensionOverrides:{batch:1}` chạy được toàn graph. Edge báo vendor `intel`, architecture `gen-12lp`, description trống. Output hữu hạn `[1,133,384]` và `[1,133,512]`. Probe synthetic init 2388,6 ms; roundtrip 11695,2 ms (shader warm-up), 253,6 ms, 131,8 ms. **Không phải video benchmark**, không dùng các số này để kết luận FPS/accuracy. Không có blocker operator đã xác nhận. Evidence: `20261101T084527Z-webgpu-compatibility/probe.json`. [ORT WebGPU](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html), [operator support](https://github.com/microsoft/onnxruntime/blob/main/js/web/docs/webgpu-operators.md).

Đã bổ sung diagnostic **cùng frame video nguồn ở 5 s**, một lượt warm-up và 10 lượt đo, ROI/padding cùng cấu hình. OpenVINO capture/JPEG/HTTP/adapter/render mean/P50/P95 **96,91/90,80/129,30 ms**; WebGPU capture/RGBA/preprocess/graph/readback/decode/render **92,23/85,80/145,60 ms**. Không có speed winner rõ từ 10 lần lặp cùng một frame; đường truyền JPEG và RGBA khác nhau, không suy ra playback FPS/accuracy. Evidence: `20261101T123801Z-runtime-decision-diagnostic/openvino-frame5s-summary.json` và `20261101T123151Z-webgpu-actual-frame-diagnostic/summary.json`; số được ghi lại từ probe JSON hiển thị, không phải bộ benchmark video hoàn chỉnh.

Với **person detector chính thức**, strict WebGPU không tạo được session: `This session contains graph nodes that are assigned to the default CPU EP, but fallback to CPU EP has been explicitly disabled by the user.` Static inspection exact ONNX thấy `TopK_573`, `NonMaxSuppression_600`, `TopK_668`; resolver WebGPU của ORT Web1.31.1 cài đặt không có TopK/NonMaxSuppression. Đây là **suy luận tĩnh về incompatibility có căn cứ**, chưa phải runtime attribution chính xác node vì lỗi verbose không chỉ node nào. Không bật CPU fallback hoặc tự sửa graph/NMS để gọi là full GPU. Evidence: `20261101T123801Z-runtime-decision-diagnostic/webgpu-detector-probe.json`.

Chọn **OpenVINO GPU vì pipeline detector + pose đã được xác minh GPU**, không vì khẳng định WebGPU chậm hơn. Không xây hai runtime production hoàn chỉnh. Dịch vụ venv riêng bind `127.0.0.1:8766`, tách inference backend chính; GPU lỗi hiện lỗi, không tự chuyển CPU/MediaPipe. Bản **rtmpose-gpu-v2** khóa cổng Windows bằng `SO_EXCLUSIVEADDRUSE`; kiểm tra chạy bản trùng bị từ chối lỗi10013, frontend kiểm tra version để tránh tiến trình service cũ trả dữ liệu. Chỉ bộ v2 lúc13:01 UTC dùng làm đối chứng chính; bản service cũ đã dừng. [OpenVINO hỗ trợ Iris Xe/Windows](https://docs.openvino.ai/2026/about-openvino/release-notes-openvino/system-requirements.html).

## C. Ánh xạ landmark và tọa độ

Chỉ số zero-based theo [COCO-WholeBody chính thức](https://github.com/open-mmlab/mmpose/blob/main/configs/_base_/datasets/coco_wholebody.py).

| Khớp | WholeBody | Canonical MediaPipe |
|---|---:|---:|
| Vai trái / phải | 5 / 6 | 11 / 12 |
| Khuỷu trái / phải | 7 / 8 | 13 / 14 |
| Cổ tay trái / phải | 9 / 10 | 15 / 16 |
| Mũi | 0 | 0 |
| Hông trái / phải, khi cần silhouette | 11 / 12 | 23 / 24 |

| Điểm bàn tay canonical | WholeBody trái | WholeBody phải |
|---|---|---|
| 0: gốc tay | 91 | 112 |
| 1, 2, 3, 4: ngón cái, từ gốc đến đầu | 92, 93, 94, 95 | 113, 114, 115, 116 |
| 5, 6, 7, 8: ngón trỏ | 96, 97, 98, 99 | 117, 118, 119, 120 |
| 9, 10, 11, 12: ngón giữa | 100, 101, 102, 103 | 121, 122, 123, 124 |
| 13, 14, 15, 16: ngón áp út | 104, 105, 106, 107 | 125, 126, 127, 128 |
| 17, 18, 19, 20: ngón út | 108, 109, 110, 111 | 129, 130, 131, 132 |

Raw133 giữ model-input pixel/score/hệ tọa độ. Canonical đảo **affine crop thực tế** về ảnh nguồn rồi chuẩn hóa x/y. JSONL lưu `tracking_region.roi/crop/roiValid/detector` cùng raw133 để dựng lại. Mirror hiển thị một lần, không đổi định danh giải phẫu. Body không có dữ liệu giữ missing (JSON null), không tạo 0,0 giả. Không tạo z/world coordinates; confidence RTMPose không được đổi tên thành visibility. Điểm invalid không đưa vào game/calibration như quan sát hợp lệ.

## D. So sánh hiệu năng

### Điều kiện và định nghĩa

Nguồn `video_test/WIN_20261101_00_59_17_Pro.mp4`, **1920×1080, 29,561396 s, 487 frame, metadata 16,514 FPS**, phát **1,0×** trên Edge. Warm-up ≥3 s suy luận khung đầu đang pause, sau đó phát toàn video. Cùng raw overlay/canvas và mục tiêu lịch 30 FPS; chạy tuần tự, đóng engine cũ trước lượt tiếp, không webcam/clinical session. Mục tiêu 30 không làm nguồn 16,5 FPS thành 30 frame mới/giây.

Ba lượt chính: MediaPipe → RTMPose operator ROI → RTMPose + detector. Detector trước mỗi lượt pose, chọn đúng một người score ≥0,5; không có/nhiều người phù hợp thì từ chối. Operator ROI đã đo là toàn ảnh `[0,0,1,1]`; padding 1,25/aspect ratio tạo crop `x=-240,y=-1060,w=2400,h=3200`, nhiều pad đen. **Đây là ROI cụ thể đã đo, chưa tối ưu chất lượng tay.** Detector tạo bbox thay đổi; đây là phương án vùng người khác của cùng Medium, không phải Large.

Pose/WholeBody FPS = số kết quả/thời gian wall-clock đo, không phải 1000/inference-ms. Hand FPS MediaPipe là tần suất model tay chạy xong; RTMPose suy luận chung nên Hand FPS/P95 độc lập N/A. Render FPS = callback canvas, khác source FPS, result FPS và FPS file ghi. File ghi yêu cầu 30 FPS nhưng thực tế có thể thấp hơn.

| Metric | MediaPipe GPU | RTMPose-m GPU ROI | RTMPose-m GPU + detector | RTMPose-l GPU |
|---|---:|---:|---:|---:|
| Pose / WholeBody result FPS | 9,28 | 5,99 | 4,50 | N/A |
| Hand inference FPS độc lập | 9,28 | N/A | N/A | N/A |
| Render FPS | 53,19 | 88,61 | 88,86 | N/A |
| Pose latency mean / P50 / P95, ms | 24,57 / 23,70 / 39,30 | 10,87 / 10,77 / 15,45 | 11,53 / 11,18 / 17,07 | N/A |
| Hand latency mean / P50 / P95, ms | 33,42 / 31,70 / 55,70 | N/A | N/A | N/A |
| Pipeline mean / P50 / P95, ms | 58,76 / 55,30 / 93,90 | 134,08 / 127,20 / 222,50 | 188,24 / 183,30 / 254,80 | N/A |
| Source-presented → delivery mean / P50 / P95, ms | 58,76 / 55,30 / 93,90 | 134,90 / 128,10 / 225,70 | 189,11 / 183,90 / 255,20 | N/A |
| Source-presented → first display mean / P50 / P95, ms | 59,07 / 55,60 / 94,30 | 143,06 / 135,30 / 233,80 | 196,90 / 193,60 / 267,10 | N/A |
| Render frame-time mean / P50 / P95, ms | 18,80 / 11,00 / 74,60 | 11,29 / 11,10 / 24,30 | 11,25 / 11,10 / 22,80 | N/A |
| Long tasks / tổng thời lượng, ms | 190 / 12805 | 0 / 0 | 0 / 0 | N/A |
| Quan sát / wall-clock đo, s | 280 / 30,156 | 180 / 30,052 | 135 / 29,980 | N/A |
| Frame source callback / bỏ trước callback | 332 / 153 | 486 / 0 | 486 / 0 | N/A |
| Frame bỏ do pipeline busy | 0 | 300 | 350 | N/A |

MediaPipe timing `detectForVideo` có phần xử lý task; OpenVINO pose timing chỉ bao quanh graph inference phía service. **Không dùng hàng Pose latency để kết luận toàn pipeline RTMPose nhanh hơn MediaPipe.** Hàng pipeline/source→display mới bao gồm capture/encode/transfer/decode/crop/model/postprocess/render. Source timestamp là media time; source-presented là browser monotonic clock. Bộ v2 lưu timestamp thực `perf_counter` cho host request/inference-start/inference-completion/postprocess-completion: **180/180 observation ROI và 135/135 detector không null**, đã kiểm tra start≤completion. Đây là thời điểm host gọi synchronous inference, **không phải timestamp GPU kernel nội bộ**; browser/service clock không đồng bộ nên không trừ chéo hai clock. MediaPipe có start/completion browser host-call. Age không phải camera-capture→display, chưa tính latency trước browser trình bày frame.

### Chi phí RTMPose đã tính detector và transfer

| Stage mean / P50 / P95, ms | ROI | Detector + Medium |
|---|---:|---:|
| Frame JPEG decode phía service | 19,76 / 19,39 / 30,55 | 20,86 / 19,89 / 31,92 |
| Detector preprocessing | N/A | 20,36 / 19,73 / 26,71 |
| Detector graph inference | N/A | 16,08 / 15,02 / 22,52 |
| Detector postprocessing | N/A | 0,36 / 0,30 / 0,62 |
| Detector tổng | N/A | 36,80 / 35,45 / 53,02 |
| Pose preprocessing/crop | 3,24 / 3,02 / 5,37 | 4,03 / 3,66 / 6,92 |
| WholeBody graph inference | 10,87 / 10,77 / 15,45 | 11,53 / 11,18 / 17,07 |
| SimCC/postprocessing | 1,69 / 1,36 / 3,50 | 1,76 / 1,44 / 3,22 |
| Tổng service | 35,56 / 35,35 / 51,81 | 75,04 / 73,49 / 104,85 |
| Tổng client pipeline | 134,08 / 127,20 / 222,50 | 188,24 / 183,30 / 254,80 |

Percentile không cộng tuyến tính. Chênh tổng client/service còn gồm capture JPEG, truyền/serialization và scheduling, chưa phân rã tuyệt đối từng khoản; không gán hết cho GPU. Detector lượt cuối thêm mean khoảng **36,80 ms** phía service; loại chi phí này sẽ làm sai so sánh. CPU diagnostic chưa chạy: N/A.

### Telemetry toàn máy

Telemetry bộ chính đọc hai thư mục `20261101-exclusive-service-host-telemetry/` và `20261101-controlled-host-telemetry/`, lọc cửa sổ **xấp xỉ** `[summary.date_time − benchmark_duration_seconds, summary.date_time]`. Cửa sổ UTC: **13:01:08,477–13:01:38,633**, **13:01:42,862–13:02:12,914**, **13:02:18,316–13:02:48,296**. `date_time` sau recorder stop/drain nên có thể lệch cleanup, không có wall-clock bắt đầu/kết thúc đo đồng bộ chính xác.

Sampler exclusive kết thúc **13:01:53,462**, chỉ bao phủ MediaPipe và phần đầu ROI. Sampler controlled bắt đầu có mẫu **13:02:49,288**, **sau detector đã kết thúc**, nên không có mẫu hardware nào trong lượt detector chính: báo **N/A**, không gán mẫu sau run cho model. ROI chỉ có5mẫu ở đoạn đầu, không đại diện toàn lượt. Các mẫu giữa hai sampler bị thiếu, không nội suy hoặc lấp gap bằng dữ liệu diagnostic khác.

| Telemetry mean (max) | MediaPipe | RTMPose ROI | RTMPose + detector |
|---|---:|---:|---:|
| Số mẫu | 14 | 5 | 0 |
| CPU toàn máy % | 27,64 (39,42) | 33,59 (45,52) | N/A |
| Busiest GPU-engine counter % | 41,23 (53,69) | 30,39 (36,23) | N/A |
| Tổng shared GPU process allocation, GiB | 2,15 (2,17) | 1,98 (1,99) | N/A |
| Dedicated GPU allocation, byte | 0 | 0 | N/A |
| RAM khả dụng mean, GiB | 0,88 | 1,16 | N/A |
| Nhiệt độ CPU/GPU die | N/A | N/A | N/A |
| Công suất watt | N/A | N/A | N/A |

GPU counters gồm **mọi process**, browser/compositor/video encode và ứng dụng nền, không quy riêng utilization cho model. Instance/engine cụ thể lưu trong telemetry JSONL; busiest-engine không phải tổng GPU utilization chuẩn hóa. Shared process allocation có thể đếm trùng buffer, không phải VRAM duy nhất. Iris Xe dùng RAM chia sẻ, dedicated=0 không có nghĩa không dùng GPU. Scheme **Balanced**, battery metadata đầu lượt trạng thái 2, 79%; không suy ra power limit/throttling. ACPI thermal zone nếu có không phải die temperature đã xác minh.

**Lượt xác nhận tài nguyên bổ trợ**, không thay số đo chính13:01UTC: `20261101T165153Z-5848d27b894444dab2e09cda3a688d6e`, detector+pose v2 đều GPU.0, phát cùng video. Sampler `20261101-detector-resource-confirmation/` có mẫu trước khi bấm chạy và xuyên suốt lượt; lọc cửa sổ xấp xỉ16:51:56,523–16:52:26,423UTC cho **12 mẫu**. Lượt này cách nhiều giờ, workload khác, không dùng làm detector column của bảng đối chứng chính.

| Detector resource confirmation | Số đo bổ trợ |
|---|---:|
| WholeBody result / render FPS | 5,82 / 89,80 |
| Pipeline mean / P50 / P95, ms | 137,97 / 125,50 / 216,80 |
| Source→first-display mean / P50 / P95, ms | 146,48 / 133,90 / 222,80 |
| CPU toàn máy mean (max), % | 22,67 (37,45) |
| Busiest GPU-engine mean (max), % | 31,60 (34,60) |
| Shared GPU process allocation mean (max), GiB | 1,77 (1,80) |
| RAM khả dụng mean, GiB | 2,55 |
| Dedicated allocation / die temperature / watts | 0 byte / N/A / N/A |

Các giới hạn counter toàn máy/đếm trùng memory/cửa sổ cleanup ở trên áp dụng cả lượt bổ trợ; không dùng chênh lệch số đo nhiều giờ để kết luận model cải tiến hoặc ưu thế lặp lại.

### Những lượt trước chỉ là diagnostic

Bộ11:34 và12:08UTC có source/video/lịch tương tự nhưng khác service version/metadata và chưa loại chắc tiến trình service cũ. **Không coi là clean matched repeats, không gộp trung bình hoặc dùng để suy ra độ biến thiên thống kê của model.** Giữ toàn bộ artifacts như lịch sử diagnostic. Chỉ bộ13:01UTC sau khóa cổng exclusive, kiểm tra version và timestamps đầy đủ làm bảng chính. Chưa có nhiều lần lặp cùng bản v2 để chứng minh ưu thế ổn định; không chọn lượt tốt nhất trong lịch sử để quảng bá một engine.

## E. Chất lượng tracking

Tỷ lệ trên **các lượt inference đã xử lý**, không phải mọi frame source. Confidence/visibility/gating khác nhau; chênh tỷ lệ không phải accuracy hơn/kém.

| Availability % | MediaPipe | RTMPose ROI | RTMPose + detector |
|---|---:|---:|---:|
| Vai trái / phải | 100,00 / 100,00 | 73,33 / 73,33 | 77,78 / 77,78 |
| Khuỷu trái / phải | 88,93 / 90,71 | 73,33 / 73,33 | 77,78 / 77,78 |
| Cổ tay trái / phải | 91,07 / 88,57 | 73,33 / 73,33 | 77,78 / 77,04 |
| Tay trái đủ hợp lệ | 69,29 | 73,33 | 77,78 |
| Tay phải đủ hợp lệ | 57,86 | 73,33 | 77,04 |
| Cả hai tay đủ hợp lệ | 56,43 | 73,33 | 77,04 |
| Điểm hợp lệ trên 21 điểm/tay, trái / phải | 75,02 / 59,76 | 73,33 / 73,33 | 77,78 / 77,04 |

RTMPose thường mất toàn bộ kết quả khi ROI gate invalid, nên nhiều tỷ lệ giống nhau; không diễn giải thành sáu joint detector độc lập cùng accuracy. Tỷ lệ điểm = số điểm hợp lệ/(21×số lượt), khác tỷ lệ đủ cả tay 21 điểm. Không nội suy missing/invalid thành raw. Filter discontinuities không phải metric riêng cho finger continuity: mất tay, frame skip và gate đều ảnh hưởng. Chưa có ground truth, sai số pixel/angle hoặc metric ground-truth riêng cho ổn định ngón: N/A.

### Tính liên tục bàn tay từ raw observations

Phân tích offline các JSONL cuối bằng `scratch/rtmpose-runtime/summarize_comparison.py`, kết quả `20261101-visual-review/final-continuity-comparison.json`. Complete = đủ 21 điểm finite/trong ảnh, không explicit invalid; RTMPose còn cần valid=true và confidence finite. Dropout = chuyển complete→missing giữa **hai lượt đã xử lý**, không phải mọi source frame hoặc chẩn đoán nguyên nhân mất tay. Pair rate = số cặp kề nhau complete cả hai đầu / tổng cặp processed observations kề nhau.

| Chỉ số raw continuity | MediaPipe | RTMPose ROI | RTMPose + detector |
|---|---:|---:|---:|
| Complete→missing, trái / phải | 16 / 15 | 5 / 5 | 6 / 6 |
| Missing→complete, trái / phải | 17 / 15 | 5 / 5 | 6 / 6 |
| Adjacent complete pairs, trái / phải trên tổng cặp | 177 / 147 / 279 | 127 / 127 / 179 | 99 / 98 / 134 |
| Adjacent complete pair rate %, trái / phải | 63,44 / 52,69 | 70,95 / 70,95 | 73,88 / 73,13 |
| Source-frame gap P95 giữa lượt xử lý, ms | 128,20 | 240,33 | 304,03 |
| Raw finger step mean / P95, tay trái | 0,0311 / 0,0907 | 0,0460 / 0,1450 | 0,0624 / 0,1762 |
| Raw finger step mean / P95, tay phải | 0,0286 / 0,0810 | 0,0446 / 0,1389 | 0,0600 / 0,1571 |

Finger step = Euclidean displacement mỗi điểm ngón **1–20**, đơn vị normalized image 2D, chỉ cặp kề complete có source gap `(0,500] ms`. Detector có99/98 complete pairs trái/phải, trong đó98/97 cặp đạt gap này để tính step. Hàng số cặp hiển thị `trái / phải / tổng cặp`. Step bao gồm chuyển động thật, lỗi estimation và camera; **không phải accuracy hay jitter ground truth**. Source gaps khác nhau khiến step lớn hơn chưa chứng minh tay rung hơn. Ít dropout hơn với số quan sát thấp/gate chung cũng không chứng minh tracking tốt hơn.

Đã xem contact sheet từ annotated thật của **bộ diagnostic11:34UTC**, không phải bộ chính v2: `20261101-visual-review/annotated-contact-sheet.jpg`, ba cột engine, ba mốc **recording khoảng5,10,20s**. Model assets/ROI tương tự nhưng service version khác nên chỉ dùng minh họa lỗi hình học, không so sánh temporal quality chuẩn của v2. Recording lệch source media do thời điểm bắt đầu/drop/result age; không phải ground-truth frame đồng bộ tuyệt đối.

| Đoạn đại diện | Quan sát overlay |
|---|---|
| Khoảng 5 s, khuỷu gập, tay giơ cạnh đầu | Cả ba có vai/khuỷu/cổ tay và hai bộ landmark tay. Kiểm tra được liên kết xương/định danh, không chứng minh mọi ngón đúng. |
| Khoảng 10 s, hai tay mở và ngón dạng | MediaPipe và RTMPose có detector thể hiện ngón mở. **RTMPose full-frame ROI co cụm điểm ngón quanh lòng bàn tay** dù tay thật mở. Raw gần source 9,936 s có minimum score 21 điểm trái/phải khoảng **0,816/0,759**: confidence cao vẫn sai hình học. Detector cho hình dạng trải ngón phù hợp hơn ở ảnh đã xem. |
| Khoảng 20 s, ngón gập/ngón cái giơ, hướng tay đổi | Cả ba giữ upper-limb skeleton, vị trí ngón khác nhau. Chưa đủ nhãn/ảnh để xếp hạng flexion, rotation hoặc continuity. |

Không thấy đổi trái/phải trong ảnh đã xem; chưa đủ đảm bảo khi tay giao nhau, che khuất nặng hoặc ra/vào khung. Video một người chưa bao phủ đầy đủ các tình huống đó: **NOT VERIFIED** cho occlusion/crossing robustness và clinical validity. Detector có hình dạng bàn tay mở phù hợp hơn ROI trong **ảnh diagnostic cũ này**, không chứng minh Medium luôn tốt hơn MediaPipe.

Đã xem thêm **bộ chính v2** `20261101-visual-review/primary-annotated-contact-sheet.jpg`, cùng ba mốc recording5/10/20s. Ở khoảng10s, **cả ba engine đều có hình dạng ngón mở**, ảnh ROI v2 không lặp lại lỗi co cụm tại đúng ảnh được chọn; một điểm hông ROI nằm thấp/lệch so với hình người, cho thấy điểm có sẵn không bảo đảm quan sát đúng. Khoảng5/20s đều có hai chi trên/hai tay, vị trí ngón khác nhau và result age khác; không đủ ground truth để xếp hạng. Do đó ví dụ lỗi ở diagnostic cũ chỉ minh họa confidence≠accuracy, **không dùng để tuyên bố detector có ưu thế chất lượng ổn định trên v2**.

## F. Khuyến nghị

**Giữ cả hai có thể chọn; MediaPipe mặc định, RTMPose WholeBody thử nghiệm.** Cả hai family dùng được GPU Iris Xe. MediaPipe pipeline/age thấp hơn ở lượt chính; RTMPose/OpenVINO graph nhanh, UI ít long task và render mượt hơn, nhưng JPEG/HTTP làm result FPS thấp và age lớn hơn. Detector có chi phí thật đã đo; chưa có bằng chứng chất lượng hơn ROI/MediaPipe ổn định trên v2.

Không khuyến nghị full-frame ROI như mặc định chất lượng tay. Trạm một người cần ROI operator xác nhận, boundary/confidence gate và xác nhận lại khi camera/ghế/tư thế đổi; detector là phương án đối chứng cần tính trong production recommendation. Chỉ một bộ chính v2, các lượt cũ là diagnostic khác version; chưa chứng minh ưu thế lặp lại. Chưa đổi production default hoặc có lý do đủ mạnh tải Large ngay.

## G. Giới hạn và phần chưa xác minh

- WholeBody chỉ 2D; z/world unavailable. Không dùng tọa độ giả cho chức năng cần 3D; FMA-UE do chuyên gia xác nhận.
- ROI/boundary/confidence không bảo đảm chi bị che vẫn trong crop. Gate có thể bỏ dữ liệu đúng hoặc lọt lỗi hình dạng; silhouette không xác nhận tư thế y khoa.
- Source frame xử lý khác nhau do latency/busy/drop dù cùng video/lịch. Chưa đánh giá accuracy trên tập source timestamps có nhãn trùng khớp.
- Video 29,56 s, một người; chưa nhiều bệnh nhân/tư thế hoặc nhiều lượt chuẩn để kết luận thống kê, nhiệt độ dài hạn. Không dựng soak/test suite lớn.
- Die temperature, wattage, GPU absolute kernel timestamp, utilization riêng model, ground-truth accuracy và finger continuity chuẩn hóa: N/A.
- JSONL diagnostic12:08UTC còn service timestamp null; **đã khắc phục ở bộ chính v2 13:01UTC**, toàn bộ180/135 observation RTMPose có host-call timestamps. Không dựng timestamp GPU kernel bằng cộng/trừ durations qua hai clock chưa đồng bộ.
- Main-thread render/record, browser/workload nền ảnh hưởng số đo. Các lượt render thấp ban đầu bị loại khỏi đối chứng chính, vẫn giữ artifacts.
- Metadata tĩnh `runtime_info.detector`/`roiStrategy` ở **bộ 11:34 UTC và cũ hơn** có thể còn mô tả ROI; đọc configuration.personDetection, person_region_strategy, tracking_region và detection timings. Bộ cuối đã có metadata detector động cùng GPU.0/gpuVerified, detectorInfo và validationRoi từng frame.
- COMPLETE xác nhận artifacts đầy đủ/đọc được, không phải chứng nhận clinical accuracy hoặc mọi patient workflow đã xác minh.

Xác minh ứng dụng: frontend build thành công, bốn file test có mục tiêu với **30 test PASS**, **bốn test backend PASS**; UI đã kiểm tra selector lưu lại, chuyển engine giữ Ghost x=0,51, Lab RTMPose có detector hiển thị hai chi trên/hai tay và chuyển lại MediaPipe báo Pose GPU/Hand GPU. Không tuyên bố mọi test đều PASS: một lần lọc test bằng substring vô tình chạy thêm `useFlowerGame.test.tsx` cũ, có17failure do Harness hiển thị overlay/panel còn controls hook gốc ở HUD; hook/test đó giống HEAD, chưa sửa ngoài phạm vi. Chạy lại đúng bốn đường dẫn mục tiêu đạt30PASS; toàn legacy suite chưa được xác minh xanh.

## H. Artifacts và tính toàn vẹn

Mọi directory dưới `rehab-data/benchmarks/`. Đã kiểm tra manifest/summary và **sáu tệp bắt buộc tồn tại, không rỗng** cho **15 lượt từ11UTC**. Backend finalize kiểm tra JSONL/CSV và decode recording. Bộ chính v2: `artifact_status=COMPLETE`, `manifest.status=COMPLETE`, `artifact_errors=[]`; observations **280/180/135**. `artifact_generation_status=PENDING_VERIFICATION` là trường frontend trước finalize; dùng trạng thái cuối artifact_status/manifest.

| Run directory | Vai trò | Trạng thái cuối |
|---|---|---|
| `20261101T130104Z-40760f450bfa439ab0b0e55ec9144128` | **Chính v2: MediaPipe GPU** | COMPLETE |
| `20261101T130139Z-5819fad632494fd096ef45d5386d7230` | **Chính v2: RTMPose ROI GPU** | COMPLETE |
| `20261101T130215Z-3405d7c234094260ad3245f038caa405` | **Chính v2: detector + RTMPose GPU** | COMPLETE |
| `20261101T165153Z-5848d27b894444dab2e09cda3a688d6e` | Bổ trợ v2: detector xác nhận tài nguyên, khác thời điểm/tải | COMPLETE |
| `20261101T120821Z-6457e4f25c7e498999fd93f34c4c0e78` | Diagnostic: MediaPipe GPU | COMPLETE |
| `20261101T120856Z-e7bf97bb075840d98156265e7511768f` | Diagnostic: RTMPose ROI, thiếu service timestamps | COMPLETE |
| `20261101T120932Z-4ad9a4e3499f46cd9b7400584257c824` | Diagnostic: detector + RTMPose, thiếu service timestamps | COMPLETE |
| `20261101T113434Z-7867f7f8599e47a285cc019babe238f6` | Diagnostic: MediaPipe GPU | COMPLETE |
| `20261101T113509Z-0338696e018443248e27030e3832e916` | Diagnostic: RTMPose ROI GPU | COMPLETE |
| `20261101T113544Z-1b35ed4a2f17484a8a2f70fea62a463f` | Diagnostic: detector + RTMPose GPU | COMPLETE |
| `20261101T111743Z-792147a7be0f4e93b534ecb405e9f84d` | Kiểm tra đầu MediaPipe, render 2,22 FPS; loại khỏi đối chứng chính | COMPLETE |
| `20261101T111820Z-4414b7e2c4c14d67807eaf3ff898dc00` | Kiểm tra đầu RTMPose ROI, render 27,95 FPS; loại khỏi đối chứng chính | COMPLETE |
| `20261101T112257Z-aebb8bed524a4e47a5d011a9af9d24ae` | Kiểm tra tiếp MediaPipe, ngoài bộ cuối | COMPLETE |
| `20261101T112332Z-859c1c7bc4064afca169b31dbcc79e88` | Kiểm tra tiếp RTMPose ROI | COMPLETE |
| `20261101T112548Z-a3d8445bbf2448dda20dae6d0612f935` | Kiểm tra tiếp RTMPose ROI | COMPLETE |

Mỗi directory trên có **annotated.mp4, landmarks.jsonl, fps.csv, summary.json, report.md, manifest.json**. Annotated dùng output thật; raw133/score/handedness/validity/media timestamp/browser timing/crop giữ riêng với filtered display. Không ghi thành clinical session hoặc ghi đè lượt cũ. Có xử lý khôi phục finalize sau backend restart trong quá trình thử; lượt đang upload/thiếu manifest không tự coi COMPLETE. Chỉ dùng trạng thái cuối sau kiểm tra/finalize, giữ lịch sử lỗi nếu có.

Evidence bổ trợ, **không phải completed video benchmark**: `20261101T084527Z-webgpu-compatibility/` (synthetic); `20261101T123151Z-webgpu-actual-frame-diagnostic/` và `20261101T123801Z-runtime-decision-diagnostic/` (frame5s/runtime decision); `20261101-exclusive-service-host-telemetry/` và `20261101-controlled-host-telemetry/` (coverage bộ chính có gap); `20261101-detector-resource-confirmation/` (sampler lượt bổ trợ); `20261101-verified-host-telemetry/`, `20261101-final-host-telemetry/`, `20261101-comparison-host-telemetry/`, `20261101-comparison2-host-telemetry/` (diagnostic trước); `20261101-visual-review/` (`primary-annotated-contact-sheet.jpg`, ảnh diagnostic cũ, `final-continuity-comparison.json` bộ chính v2 và bản continuity diagnostic12:08 được giữ riêng). Benchmark trước11UTC bảo toàn, không đưa vào bảng chính hoặc diễn giải lại trạng thái.

Thiết lập tại `scratch/rtmpose-runtime/README.md`; model/runtime giữ cục bộ, venv riêng và service localhost. Camera Calibration lưu engine trong settings; switching đóng/drain engine cũ, xóa landmark cũ, giữ camera/mirror/Ghost. Tracking Lab chọn ROI hoặc detector, có nguồn video HTTP localhost. Chế độ tùy chọn so sánh **hai recording cạnh nhau** đã kiểm tra cả hai phát đến khoảng8,67/8,68s; đây là replay artifacts, không chạy hai inference đồng thời hoặc lấy replay FPS làm benchmark. Benchmark tách khỏi patient results.

## I. Rollback

Nhánh gốc `lab-gpu-test`, commit `cb1cb8532089e194949c0353dbb5469f78feee41` giữ nguyên; làm ở `rtmpose-wholebody-evaluation`, không push nhánh gốc. Trong nhánh thử nghiệm chọn MediaPipe để đóng RTMPose, không chạy song song. Muốn trở về toàn bộ MediaPipe-only: lưu thay đổi hiện tại rồi checkout `lab-gpu-test`. Không reset/drop DB, xóa model MediaPipe hay artifacts. Có thể dừng riêng dịch vụ RTMPose localhost; runtime thử nghiệm không thay inference backend lâm sàng.
