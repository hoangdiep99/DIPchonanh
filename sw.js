/**
 * DIPchonanh Progressive Web App — Service Worker
 * Chiến lược Network-First an toàn cho giao diện web:
 * - Luôn ưu tiên tải bản mới nhất từ GitHub Pages để không bao giờ bị kẹt cache cũ.
 * - Tự động dự phòng bộ nhớ đệm khi mạng chập chờn hoặc mất kết nối.
 * - Không chặn luồng ảnh Google Drive, Google Apps Script Webhook hay CDN AI.
 */

const CACHE_NAME = 'dipchonanh-pwa-v10.24';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('dipchonanh-pwa-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Chỉ áp dụng cache cho tài nguyên cùng tên miền (GitHub Pages / localhost)
  // Bỏ qua Google Drive, Apps Script Webhook, CDN jsDelivr, Google Fonts
  if (url.origin !== self.location.origin) {
    return;
  }

  // Bỏ qua file dữ liệu khuôn mặt lớn để luôn lấy mới nhất
  if (url.pathname.includes('/data/faces_')) {
    return;
  }

  // Network-First: luôn ưu tiên lấy bản mới nhất từ mạng, lỗi mạng mới đọc cache
  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return networkRes;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});
