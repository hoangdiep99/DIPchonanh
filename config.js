/**
 * Cấu hình Studio — Chỉnh sửa trực tiếp file này trước khi đẩy lên GitHub Pages.
 * Tham khảo README.md để lấy Google Drive API Key và cài đặt Google Sheets / Telegram.
 */
export const STUDIO_CONFIG = {
  // Tên thương hiệu Studio hiển thị trên Header, tiêu đề trang & lời nhắn mẫu
  studioName: 'DIPchonanh',
  studioSubtitle: 'Hệ thống chọn ảnh trực tuyến',
  studioHotline: '0901 234 567',

  // Google Drive API v3 Key (Bắt buộc giới hạn HTTP Referrer tới tên miền GitHub Pages của bạn)
  // Ví dụ: https://username.github.io/*
  googleDriveApiKey: '',

  // URL Web App của Google Apps Script (xem file apps-script/Code.gs) để lưu đơn về Google Sheets
  // Nếu để trống, khách vẫn có thể xem tóm tắt, sao chép danh sách và tải báo cáo.
  googleSheetsWebhookUrl: 'https://script.google.com/macros/s/AKfycbz45Rz8NJuOjIK-3eQt11jQVL9u5mWV9dp33Vev2_Bc5JN_hrnQQgjK1Xj3bgkC60x5/exec',

  // Tài khoản đăng nhập trang Quản trị Studio (#admin)
  // Mật khẩu được lưu & xác thực bí mật 100% trên Google Apps Script (không lưu công khai trên GitHub)
  adminAuth: {
    username: 'hoangdiep',
  },

  // (Tùy chọn) Gửi thẳng thông báo về Telegram Bot từ trình duyệt.
  // Khuyến nghị: Để bảo mật Bot Token khi đẩy lên GitHub, gửi Telegram qua Google Apps Script (Code.gs) tự động 100%.
  telegramBotToken: '',
  telegramChatId: '',

  // Bộ Tag ghi chú nhanh một chạm trong Lightbox
  quickTags: [
    'Bóp mặt / dáng',
    'Mịn da tự nhiên',
    'Xóa người / vật thừa',
    'Chỉnh sáng / màu',
    'In phóng lớn',
  ],

  // Danh sách gợi ý gói chụp trong giao diện #admin
  packagePresets: [
    { label: 'Cưới Trọn Gói (30 ảnh)', value: 'Cuoi_Tron_Goi', limit: 30 },
    { label: 'Áo Dài Studio (20 ảnh)', value: 'Ao_Dai_Studio', limit: 20 },
    { label: 'Pre-Wedding Ngoại Cảnh (40 ảnh)', value: 'Pre_Wedding', limit: 40 },
    { label: 'Phóng Sự Cưới (60 ảnh)', value: 'Phong_Su_Cuoi', limit: 60 },
    { label: 'Gia Đình / Baby (15 ảnh)', value: 'Gia_Dinh_Studio', limit: 15 },
    { label: 'Không giới hạn', value: 'Chon_Tu_Do', limit: 0 },
  ],

  // Danh sách album mặc định của Studio hiển thị trong Quản lý Link Đã Tạo
  defaultAlbums: [
    {
      folderId: '17cOYU7FhxtOs9yTw_RbZs_fj9yAdepTI',
      client: 'doi cuoi tu son 21',
      pkg: 'Album Tiêu Chuẩn',
      slug: 'doi-cuoi-tu-son-21',
      limit: 0,
      download: 1,
      time: 'Album hiện tại',
    },
    {
      folderId: '1o4maN-z8SsUB3h-GLAUrK1DBjDbU7AlP',
      client: 'Việt Phục',
      pkg: 'Album Tiêu Chuẩn',
      slug: 'viet-phuc',
      limit: 0,
      download: 1,
      time: 'Album hiện tại',
    },
    {
      folderId: '1g8AZVnAvlDvJrt3Ev3z9xHf0NwcErOY0',
      client: 'Sự kiện Tết',
      pkg: 'Album Tiêu Chuẩn',
      slug: 'su-kien-tets',
      limit: 0,
      download: 1,
      time: '23/11/2026',
    },
  ],

  // Cấu hình Nhận diện khuôn mặt nhẹ trên trình duyệt (@vladmandic/human)
  faceAI: {
    // Phiên bản CDN đồng bộ giữa ESM module và thư mục models (~5-6MB tải khi bấm lọc)
    esmUrl: 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/dist/human.esm.js',
    modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/models/',
    // Số ảnh quét mỗi lượt (batch) để tránh đơ giao diện điện thoại
    batchSize: 6,
    // Ngưỡng tương đồng mặc định (0.0 - 1.0). Khuyến nghị 0.50 - 0.58 cho ảnh cưới/chân dung
    defaultThreshold: 0.60,
    // Ngưỡng gom cụm nhân vật khi quét album (giữ thấp để không tách 1 người thành nhiều nhóm)
    clusterThreshold: 0.52,
  },
  // AI lọc ảnh lỗi (mờ / nhắm mắt / ảnh chụp liên tiếp giống nhau)
  qualityAI: {
    // Ảnh có độ nét thấp hơn 38% mức trung bình của album -> nghi mờ (tăng để bắt chặt hơn)
    blurRatio: 0.38,
    // Tỉ lệ mở mắt < 0.18 -> nghi nhắm mắt (tăng để bắt nhiều hơn, giảm để ít báo nhầm)
    blinkEar: 0.18,
    // Độ khác nhau tối đa giữa 2 ảnh liên tiếp để coi là giống nhau (0-64, càng lớn gom càng nhiều)
    dupHamming: 10,
  },
};
