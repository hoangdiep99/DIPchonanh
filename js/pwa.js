/**
 * DIPchonanh Progressive Web App (PWA) Controller
 * - Đăng ký Service Worker (sw.js)
 * - Bắt sự kiện cài đặt 1-chạm trên Android / Chrome / Edge / Brave
 * - Hiển thị hướng dẫn trực quan 2 bước "Thêm vào MH chính" cho iPhone / iPad (Safari)
 * - Tự động ẩn nút cài đặt khi đã mở ở chế độ App độc lập (standalone)
 */

(function initDIPchonanhPWA() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true ||
    document.referrer.startsWith('android-app://');

  const ua = window.navigator.userAgent || '';
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);

  let deferredPrompt = null;

  function showToast(msg) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast toast-success';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-6px)';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  // 1. Đăng ký Service Worker
  if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./sw.js', { scope: './' })
        .catch((err) => {
          console.warn('PWA Service Worker registration skipped:', err);
        });
    });
  }

  // 2. Xử lý nút Cài App & Modal hướng dẫn iOS
  function setupInstallUI() {
    const installBtn = document.getElementById('btn-pwa-install');
    const iosModal = document.getElementById('pwa-ios-modal');
    const iosCloseBtn = document.getElementById('pwa-ios-close');
    const iosBackdrop = document.getElementById('pwa-ios-backdrop');

    if (!installBtn) return;

    // Nếu đang mở dưới dạng App đã cài -> ẩn nút cài đặt
    if (isStandalone) {
      installBtn.classList.add('hidden');
      return;
    }

    // Trên iOS Safari: hiện nút để mở bảng hướng dẫn 2 bước
    if (isIOS) {
      installBtn.classList.remove('hidden');
    }

    // Trên Android / Chrome / Edge / Brave: chờ trình duyệt phát tín hiệu sẵn sàng cài
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.classList.remove('hidden');
    });

    installBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        try {
          deferredPrompt.prompt();
          const { outcome } = await deferredPrompt.userChoice;
          if (outcome === 'accepted') {
            installBtn.classList.add('hidden');
          }
          deferredPrompt = null;
        } catch (err) {
          console.warn('Lỗi khi gọi hộp thoại cài App:', err);
        }
        return;
      }

      // Nếu là iOS hoặc trình duyệt chưa cung cấp prompt tự động -> mở hướng dẫn
      if (iosModal) {
        iosModal.classList.remove('hidden');
      }
    });

    const closeModal = () => iosModal?.classList.add('hidden');
    iosCloseBtn?.addEventListener('click', closeModal);
    iosBackdrop?.addEventListener('click', closeModal);

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      installBtn.classList.add('hidden');
      closeModal();
      showToast('🎉 Đã cài đặt ứng dụng DIPchonanh thành công!');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupInstallUI);
  } else {
    setupInstallUI();
  }
})();
