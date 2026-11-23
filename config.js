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
  googleSheetsWebhookUrl: 'https://script.google.com/macros/s/AKfycbwhM56WIhLELKURPR4q48gbjN0_S__6pXu0XP369sJeFKE3L3ffByWEJaQZ566IOZ4A/exec',

  // Tài khoản đăng nhập trang Quản trị Studio (#admin)
  // Studio có thể đổi mật khẩu tại đây
  adminAuth: {
    username: 'hoangdiep',
    password: 'diep2026',
  },

  // (Tùy chọn) Gửi thẳng thông báo về Telegram Bot từ trình duyệt.
  // Khuyến nghị: Để bảo mật Bot Token khi đẩy lên GitHub, gửi Telegram qua Google Apps Script (Code.gs) tự động 100%.
  telegramBotToken: '',
  telegramChatId: '2062937107',

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

  // Cấu hình Nhận diện khuôn mặt nhẹ trên trình duyệt (@vladmandic/human)
  faceAI: {
    // Phiên bản CDN đồng bộ giữa ESM module và thư mục models (~5-6MB tải khi bấm lọc)
    esmUrl: 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/dist/human.esm.js',
    modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/models/',
    // Số ảnh quét mỗi lượt (batch) để tránh đơ giao diện điện thoại
    batchSize: 6,
    // Ngưỡng tương đồng mặc định (0.0 - 1.0). Khuyến nghị 0.50 - 0.58 cho ảnh cưới/chân dung
    defaultThreshold: 0.52,
  },
};
