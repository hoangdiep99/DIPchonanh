# Studio Photo Selector — Hệ Thống Chọn Ảnh Trực Tuyến Tối Giản Cho Nhiếp Ảnh Gia

Hệ thống chọn ảnh trực tuyến tinh gọn theo phong cách **Minimalist Editorial Gallery**, chạy 100% Client-side (Static Web) không tốn chi phí máy chủ, hỗ trợ tối ưu trải nghiệm khách hàng chọn ảnh cưới, áo dài, phóng sự, kỷ yếu và chân dung nghệ thuật.

---

## 🌟 Điểm Nổi Bật

1. **Giao Diện Editorial Sang Trọng**: Bảng màu Trắng ngà ấm (`#F8F7F4`), viền mảnh (`#E4E4E7`), kính mờ mượt mà, giữ nguyên tỷ lệ khung hình gốc (Justified Grid) không cắt xén góc ảnh.
2. **Duyệt Ảnh Google Drive 3 Cấp Độ (Progressive Loading)**:
   - *Cấp 1 (Quét AI)*: Thumbnail `sz=w400` nhẹ tênh (~20-30KB) để nhận diện khuôn mặt cực nhanh.
   - *Cấp 2 (Lưới hiển thị)*: `sz=w800` kết hợp `IntersectionObserver` cuộn mượt không tràn RAM điện thoại.
   - *Cấp 3 (Xem lớn & Tải gốc)*: `sz=w2048` cho Lightbox và nút tải file gốc chất lượng cao (nếu bật).
3. **Thao Tác Một Tay Trên Điện Thoại (Floating Bottom Bar)**:
   - Bộ đếm định mức ảnh gói (`tabular-nums`), tự động cảnh báo đổi màu khi vượt giới hạn (VD: `34 / 30 ảnh — Phát sinh +4 ảnh`).
   - Bộ lọc trạng thái: Tất cả, Đã chọn (♥), Chưa chọn, Ưu tiên / In phóng (★), Đã ghi chú.
4. **Trình Xem Lớn Lightbox Chuyên Sâu**:
   - Vuốt trái / phải trên điện thoại, phím mũi tên trên máy tính.
   - Phóng to kiểm tra nét và biểu cảm (nút zoom, cuộn chuột, chạm đúp, chụm 2 ngón tay & kéo pan).
   - Thanh dock thu gọn thông minh với 5 nút **Quick Tags một chạm**: *Bóp mặt / dáng, Mịn da tự nhiên, Xóa người / vật thừa, Chỉnh sáng / màu, In phóng lớn* cùng ô ghi chú chi tiết.
5. **Lọc Khuôn Mặt Nhẹ Trên Trình Duyệt (@vladmandic/human)**:
   - Tải trì hoãn (Lazy-load): Chỉ nạp mô hình AI (~5MB) khi khách bấm nút lọc.
   - Quy trình "Chạm 1 ảnh mẫu để tìm": Tự nhận diện và vẽ khung khuôn mặt trong ảnh mẫu để khách chạm chọn người cần tìm, sau đó quét theo lô (batch) và lưu đệm vector vào IndexedDB.
6. **Hậu Kỳ Cực Nhanh (Capture One / Lightroom Integration)**:
   - Xuất chuỗi tên file phân cách bằng dấu phẩy: `DSC_0012, DSC_0045, DSC_0108...` (tùy chọn giữ/bỏ `.jpg`).
   - Studio chỉ cần copy 1 lần và dán vào tính năng **Select by Filename List** trên Capture One để tách ngay các file RAW cần chỉnh sửa.
7. **Tự Động Lưu Nháp (LocalStorage Offline-First)**: Lưu theo khóa riêng `studio_select_<FOLDER_ID>`, mất mạng hoặc tắt trình duyệt mở lại vẫn nguyên vẹn.
8. **Trình Tạo Link Nhanh Cho Studio (`#admin`)**: Bóc tách tự động Google Drive Folder ID, sinh link đầy đủ và soạn sẵn tin nhắn mẫu gửi qua Zalo/Messenger cho khách.

---

## 🚀 Cấu Trúc Tham Số Đường Dẫn (URL Parameters)

| Tham số | Ý nghĩa | Ví dụ |
| :--- | :--- | :--- |
| `folder` | **Bắt buộc**: ID thư mục Google Drive chứa ảnh của khách | `1u2x3y4z5A6B7C...` |
| `khach` | Tên khách hàng hoặc mã hợp đồng (hiển thị trên tiêu đề & báo cáo) | `Anh_Nam_Chi_Linh` |
| `goi` | Tên gói chụp (VD: Cuoi_Tron_Goi, Ao_Dai_Studio, Pre_Wedding) | `Cuoi_Tron_Goi` |
| `limit` | Số lượng ảnh tiêu chuẩn trong gói (để trống hoặc 0 = không giới hạn) | `30` |
| `download` | Quyền tải ảnh gốc: `1` = Cho phép tải; `0` = Ẩn nút tải ảnh gốc | `0` |
| `#admin` | Hash mở giao diện Quản trị tạo link cho Studio (ẩn với khách thông thường) | `index.html#admin` |

**Ví dụ đường dẫn hoàn chỉnh:**
```text
https://yourname.github.io/studio-photo-selector/?folder=1fG8H9jK0L...&khach=Thanh_Hang_Quoc_Bao&goi=Cuoi_Tron_Goi&limit=30&download=0
```

---

## 🛠️ Hướng Dẫn Cấu Hình & Triển Khai Miễn Phí (GitHub Pages)

### Bước 1: Lấy Google Drive API Key
1. Truy cập [Google Cloud Console](https://console.cloud.google.com/).
2. Tạo dự án mới (hoặc dùng dự án có sẵn).
3. Vào **APIs & Services** > **Library**, tìm **Google Drive API** và bấm **Enable**.
4. Vào **APIs & Services** > **Credentials**, bấm **Create Credentials** > **API Key**.
5. Bấm vào API Key vừa tạo để cài đặt bảo mật:
   - Tại mục **Set application restrictions**: Chọn **Websites (HTTP referrers)**.
   - Thêm tên miền web của bạn: `https://<username>.github.io/*` (hoặc `http://localhost:*` khi chạy thử nghiệm trên máy).
   - Tại mục **API restrictions**: Chọn **Restrict key** và tick chọn duy nhất **Google Drive API**.
6. Mở file `config.js` và dán API Key vào:
   ```javascript
   googleDriveApiKey: 'AIzaSyA...',
   ```

### Bước 2: Cài Đặt Quyền Thư Mục Google Drive
- Thư mục ảnh chụp gửi cho khách trên Google Drive cần đặt ở quyền: **"Bất kỳ ai có đường liên kết đều có thể xem" (Viewer)**.
- Thư mục có thể chứa trực tiếp các file ảnh hoặc chứa các thư mục con phân cảnh (VD: *Lễ gia tiên, Tiệc cưới, Ngoại cảnh*), hệ thống sẽ tự động quét và phân chia thành các tab điều hướng.

### Bước 3: (Tùy chọn) Lưu Đơn Vào Google Sheets & Gửi Telegram
1. Mở [Google Apps Script](https://script.google.com/) và tạo dự án mới.
2. Dán nội dung trong file `apps-script/Code.gs` vào.
3. Điền `SPREADSHEET_ID` của Google Sheet nhận đơn (và Token Telegram nếu muốn).
4. Bấm **Deploy (Triển khai)** > **New deployment** > Loại: **Web app**.
   - Quyền truy cập (*Who has access*): Chọn **Anyone (Bất kỳ ai)**.
5. Sao chép URL Web App vừa sinh ra và dán vào `STUDIO_CONFIG.googleSheetsWebhookUrl` trong `config.js`.

### Bước 4: Đẩy Lên GitHub Pages
1. Tạo repository mới trên GitHub (VD: `photo-selector`).
2. Tải toàn bộ mã nguồn lên repository.
3. Vào **Settings** > **Pages** > Chọn branch `main` và thư mục `/root` > Bấm **Save**.
4. Website của bạn sẽ hoạt động trực tiếp tại: `https://<username>.github.io/<repo-name>/`.

---

## 💻 Trải Nghiệm Chế Độ Demo

Khi mở trực tiếp `index.html` (không truyền tham số `folder`), website sẽ tự động nạp **Album Demo mẫu** tích hợp sẵn gồm 9 bức ảnh đám cưới truyền thống Áo Dài Việt Nam đã được phân nhóm theo 3 thư mục phân cảnh:
- Thử nghiệm thả tim chọn ảnh, gắn sao ưu tiên.
- Thử nghiệm các nút Quick Tag một chạm và ghi chú riêng.
- Bấm **"Lọc khuôn mặt"** để trải nghiệm AI trích xuất vector khuôn mặt và tìm kiếm người siêu nhanh.
- Bấm **"Gửi danh sách"** để xem chuỗi tên file định dạng sẵn cho Capture One / Lightroom.
- Thêm `#admin` vào thanh địa chỉ để mở Trình tạo link nhanh.
