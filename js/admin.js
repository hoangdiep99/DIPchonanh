/**
 * Phân hệ 4.5: Quản trị Tạo Link, Chỉnh Sửa & Quản Lý Album Cho Studio (#admin)
 * - Đăng nhập cá nhân tiện lợi (Ghi nhớ vĩnh viễn trên máy tính này, mở nhanh 1-chạm).
 * - Chỉnh sửa trực tiếp các link đã tạo (đổi tên, link drive, gói chụp, định mức).
 * - Sinh đường link siêu ngắn gọn theo tên khách (Ví dụ: ?k=namlinh hoặc ?k=doicuoi).
 * - Thao tác 1-chạm ngay trên từng card: Copy Link, Copy Zalo, Chỉnh sửa, Mở, Xóa.
 */
import { STUDIO_CONFIG } from '../config.js?v=8.2';
import { extractDriveFolderId } from './drive.js?v=8.2';

const ADMIN_STORAGE_KEY = 'studio_admin_history';
const ADMIN_REMEMBER_KEY = 'studio_admin_remember';
const ADMIN_CUSTOM_PASS_KEY = 'studio_admin_pass';

function toSlug(str) {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class AdminManager {
  constructor(adminContainerEl, onApplyLink) {
    this.container = adminContainerEl;
    this.onApplyLink = onApplyLink;
    this.history = this.loadHistory();
    this.historySearchQuery = '';
    this.editingIndex = -1; // -1: đang tạo mới; >= 0: đang chỉnh sửa link

    this.bindAuthElements();
    this.bindElements();
    this.bindEvents();
    this.checkAuthState();
  }

  loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(ADMIN_STORAGE_KEY)) || [];
    } catch {
      return [];
    }
  }

  saveHistory(item) {
    if (this.editingIndex >= 0 && this.editingIndex < this.history.length) {
      // Chế độ chỉnh sửa
      this.history[this.editingIndex] = item;
      this.editingIndex = -1;
    } else {
      // Chế độ tạo mới
      this.history = [item, ...this.history.filter((h) => h.folderId !== item.folderId)].slice(0, 50);
    }

    try {
      localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(this.history));
    } catch {
      // ignore
    }
    this.renderHistory();
  }

  deleteHistoryItem(index) {
    this.history.splice(index, 1);
    try {
      localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(this.history));
    } catch {
      // ignore
    }
    this.renderHistory();
  }

  // --- ĐĂNG NHẬP CÁ NHÂN TIỆN LỢI (1-CHẠM & GHI NHỚ VĨNH VIỄN) ---
  bindAuthElements() {
    this.loginCard = this.container.querySelector('#admin-login-card');
    this.panelContent = this.container.querySelector('#admin-panel-content');
    this.loginForm = this.container.querySelector('#admin-login-form');
    this.usernameInput = this.container.querySelector('#login-username');
    this.passwordInput = this.container.querySelector('#login-password');
    this.rememberCheckbox = this.container.querySelector('#login-remember-me');
    this.btnQuickLogin = this.container.querySelector('#btn-quick-admin-login');
    this.loginErrorMsg = this.container.querySelector('#login-error-msg');
    this.btnLogout = this.container.querySelector('#admin-btn-logout');
    this.btnChangePass = this.container.querySelector('#admin-btn-change-pass');

    this.loginForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleLogin();
    });

    // Chỉ hiển thị nút 1-chạm khi đang chạy thử nghiệm cục bộ (localhost)
    const isLocalDev = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
    if (this.btnQuickLogin && !isLocalDev) {
      this.btnQuickLogin.classList.add('hidden');
    }

    this.btnQuickLogin?.addEventListener('click', () => {
      // Mở nhanh 1-chạm dành riêng cho chủ Studio
      this.grantAccess(true);
    });

    this.btnLogout?.addEventListener('click', () => {
      this.handleLogout();
    });

    this.btnChangePass?.addEventListener('click', () => {
      this.handleChangePassword();
    });
  }

  isLoggedIn() {
    const isRemembered = localStorage.getItem(ADMIN_REMEMBER_KEY) === 'true';
    return isRemembered || sessionStorage.getItem('studio_admin_session') === 'true';
  }

  checkAuthState() {
    // Nếu trước đó đã tích chọn "Ghi nhớ trên máy tính này", tự động mở thẳng
    const isAuthed = this.isLoggedIn();

    if (this.loginCard) this.loginCard.classList.toggle('hidden', isAuthed);
    if (this.panelContent) this.panelContent.classList.toggle('hidden', !isAuthed);

    if (isAuthed) {
      this.renderPresets();
      this.renderHistory();
    }
  }

  grantAccess(remember = true) {
    if (remember) {
      localStorage.setItem(ADMIN_REMEMBER_KEY, 'true');
    }
    sessionStorage.setItem('studio_admin_session', 'true');
    this.loginErrorMsg?.classList.add('hidden');
    this.checkAuthState();
  }

  handleLogin() {
    const p = this.passwordInput?.value ? this.passwordInput.value.trim() : '';
    const u = this.usernameInput?.value ? this.usernameInput.value.trim().toLowerCase() : 'hoangdiep';

    const validUser = (STUDIO_CONFIG.adminAuth?.username || 'hoangdiep').toLowerCase();
    const customPass = localStorage.getItem(ADMIN_CUSTOM_PASS_KEY);
    const validPass = customPass || STUDIO_CONFIG.adminAuth?.password || 'diep2026';

    // Đăng nhập thành công nếu đúng mã PIN (dù có nhập username hay không)
    if (p === validPass && (u === validUser || !this.usernameInput)) {
      const remember = this.rememberCheckbox ? this.rememberCheckbox.checked : true;
      this.grantAccess(remember);
    } else {
      this.loginErrorMsg?.classList.remove('hidden');
      if (this.passwordInput) {
        this.passwordInput.value = '';
        this.passwordInput.focus();
      }
    }
  }

  handleLogout() {
    localStorage.removeItem(ADMIN_REMEMBER_KEY);
    sessionStorage.removeItem('studio_admin_session');
    this.checkAuthState();
  }

  handleChangePassword() {
    const currentPass = localStorage.getItem(ADMIN_CUSTOM_PASS_KEY) || STUDIO_CONFIG.adminAuth?.password || 'diep2026';
    const oldInput = prompt('Nhập mật khẩu hiện tại của bạn:', '');
    if (oldInput === null) return;
    if (oldInput !== currentPass) {
      alert('Mật khẩu hiện tại không đúng!');
      return;
    }
    const newPass = prompt('Nhập mật khẩu mới muốn đặt:', '');
    if (!newPass || !newPass.trim()) {
      alert('Mật khẩu không được để trống!');
      return;
    }
    localStorage.setItem(ADMIN_CUSTOM_PASS_KEY, newPass.trim());
    alert('✅ Đã đổi mật khẩu Studio thành công!');
  }

  // --- GIAO DIỆN FORM VÀ CHỈNH SỬA LINK ---
  bindElements() {
    this.formTitle = this.container.querySelector('#admin-form-title');
    this.editingBanner = this.container.querySelector('#admin-editing-banner');
    this.editingNameEl = this.container.querySelector('#admin-editing-name');
    this.btnCancelEdit = this.container.querySelector('#admin-btn-cancel-edit');

    this.driveInput = this.container.querySelector('#admin-drive-url');
    this.folderIdBadge = this.container.querySelector('#admin-folder-id-badge');
    this.clientInput = this.container.querySelector('#admin-client-name');
    this.packageInput = this.container.querySelector('#admin-package-name');
    this.shortSlugInput = this.container.querySelector('#admin-short-slug');
    this.limitInput = this.container.querySelector('#admin-limit');
    this.downloadToggle = this.container.querySelector('#admin-download-toggle');
    this.presetChipsEl = this.container.querySelector('#admin-preset-chips');

    this.btnGenerate = this.container.querySelector('#admin-btn-generate');
    this.resultWrap = this.container.querySelector('#admin-result-wrap');
    this.resultShortUrl = this.container.querySelector('#admin-result-short-url');
    this.resultUrl = this.container.querySelector('#admin-result-url');
    this.resultMsg = this.container.querySelector('#admin-result-msg');
    this.btnCopyShortUrl = this.container.querySelector('#admin-btn-copy-short-url');
    this.btnCopyUrl = this.container.querySelector('#admin-btn-copy-url');
    this.btnCopyMsg = this.container.querySelector('#admin-btn-copy-msg');
    this.btnOpenLink = this.container.querySelector('#admin-btn-open-link');

    this.historyListEl = this.container.querySelector('#admin-history-list');
    this.historyCountEl = this.container.querySelector('#admin-history-count');
    this.historySearchInput = this.container.querySelector('#admin-history-search');

    this.historySearchInput?.addEventListener('input', () => {
      this.historySearchQuery = this.historySearchInput.value.trim().toLowerCase();
      this.renderHistory();
    });

    // Tự động sinh mã slug ngắn khi gõ tên khách
    this.clientInput?.addEventListener('input', () => {
      if (this.editingIndex === -1 && this.shortSlugInput) {
        this.shortSlugInput.value = toSlug(this.clientInput.value);
      }
    });

    this.btnCancelEdit?.addEventListener('click', () => {
      this.cancelEdit();
    });
  }

  bindEvents() {
    this.driveInput?.addEventListener('input', () => this.handleDriveInput());
    this.btnGenerate?.addEventListener('click', () => this.generateOrUpdateLink());

    this.btnCopyShortUrl?.addEventListener('click', () => {
      if (this.resultShortUrl?.value) {
        navigator.clipboard.writeText(this.resultShortUrl.value);
        this.showButtonFeedback(this.btnCopyShortUrl, 'Đã copy link ngắn!');
      }
    });

    this.btnCopyUrl?.addEventListener('click', () => {
      if (this.resultUrl?.value) {
        navigator.clipboard.writeText(this.resultUrl.value);
        this.showButtonFeedback(this.btnCopyUrl, 'Đã copy link!');
      }
    });

    this.btnCopyMsg?.addEventListener('click', () => {
      if (this.resultMsg?.value) {
        navigator.clipboard.writeText(this.resultMsg.value);
        this.showButtonFeedback(this.btnCopyMsg, 'Đã copy tin nhắn!');
      }
    });

    this.btnOpenLink?.addEventListener('click', () => {
      const url = this.resultShortUrl?.value || this.resultUrl?.value;
      if (url) {
        window.location.href = url;
      }
    });
  }

  handleDriveInput() {
    const val = this.driveInput.value.trim();
    const folderId = extractDriveFolderId(val);

    if (folderId) {
      this.folderIdBadge.textContent = `ID: ${folderId}`;
      this.folderIdBadge.className = 'extracted-badge is-ok';
      this.folderIdBadge.classList.remove('hidden');
    } else if (val) {
      this.folderIdBadge.textContent = 'Chưa nhận diện được ID';
      this.folderIdBadge.className = 'extracted-badge is-err';
      this.folderIdBadge.classList.remove('hidden');
    } else {
      this.folderIdBadge.classList.add('hidden');
    }
  }

  renderPresets() {
    if (!this.presetChipsEl) return;
    this.presetChipsEl.innerHTML = '';
    for (const preset of STUDIO_CONFIG.packagePresets) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'preset-chip';
      chip.textContent = preset.label;
      chip.addEventListener('click', () => {
        this.packageInput.value = preset.value;
        this.limitInput.value = preset.limit;
      });
      this.presetChipsEl.appendChild(chip);
    }
  }

  // Bắt đầu chỉnh sửa một link có sẵn
  startEdit(index) {
    const item = this.history[index];
    if (!item) return;

    this.editingIndex = index;
    this.driveInput.value = item.folderId;
    this.clientInput.value = item.client;
    this.packageInput.value = item.pkg;
    this.shortSlugInput.value = item.slug || toSlug(item.client);
    this.limitInput.value = item.limit || '';
    this.downloadToggle.checked = item.download === 1;

    this.handleDriveInput();

    if (this.formTitle) this.formTitle.textContent = `Chỉnh sửa link: ${item.client}`;
    if (this.editingBanner) this.editingBanner.classList.remove('hidden');
    if (this.editingNameEl) this.editingNameEl.textContent = item.client;
    if (this.btnGenerate) this.btnGenerate.textContent = `💾 Cập nhật link khách "${item.client}"`;

    this.driveInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  cancelEdit() {
    this.editingIndex = -1;
    if (this.formTitle) this.formTitle.textContent = '1. Thông tin hợp đồng & Drive';
    if (this.editingBanner) this.editingBanner.classList.add('hidden');
    if (this.btnGenerate) this.btnGenerate.textContent = 'Tạo Link & Lời Nhắn Mẫu';

    this.driveInput.value = '';
    this.clientInput.value = '';
    this.packageInput.value = '';
    this.shortSlugInput.value = '';
    this.limitInput.value = '';
    this.downloadToggle.checked = true;
    this.handleDriveInput();
    this.resultWrap.classList.add('hidden');
  }

  generateOrUpdateLink() {
    const rawDrive = this.driveInput.value.trim();
    const folderId = extractDriveFolderId(rawDrive);

    if (!folderId) {
      alert('Vui lòng dán link Google Drive hoặc nhập ID thư mục hợp lệ!');
      this.driveInput.focus();
      return;
    }

    const client = this.clientInput.value.trim() || 'Khach_Hang';
    const pkg = this.packageInput.value.trim() || 'Tieu_Chuan';
    const slug = (this.shortSlugInput.value.trim() || toSlug(client)).toLowerCase();
    const limit = parseInt(this.limitInput.value, 10) || 0;
    const download = this.downloadToggle.checked ? 1 : 0;

    const baseOrigin = window.location.origin + window.location.pathname;

    // 1. Link ngắn gọn theo tên khách (kèm mã f để mở được trên mọi điện thoại của khách hàng)
    let shortUrl = `${baseOrigin}?k=${encodeURIComponent(slug)}&f=${encodeURIComponent(folderId)}`;
    if (limit > 0) shortUrl += `&limit=${limit}`;

    // 2. Link đầy đủ
    const fullParams = new URLSearchParams();
    fullParams.set('folder', folderId);
    fullParams.set('khach', client);
    if (pkg && pkg !== 'Album Tiêu Chuẩn' && pkg !== 'Tieu_Chuan') fullParams.set('goi', pkg);
    if (limit > 0) fullParams.set('limit', limit);
    fullParams.set('download', download);
    const fullUrl = `${baseOrigin}?${fullParams.toString()}`;

    // Lời nhắn Zalo lịch sự
    const pkgText = (pkg && pkg !== 'Album Tiêu Chuẩn' && pkg !== 'Tieu_Chuan') ? ` cho gói "${pkg.replace(/_/g, ' ')}"` : '';
    const msgTemplate = [
      `Dạ em chào anh/chị ${client}! ✨`,
      `${STUDIO_CONFIG.studioName} gửi anh/chị đường link để xem và chọn ảnh${pkgText}:`,
      `👉 ${shortUrl}`,
      ``,
      `📌 HƯỚNG DẪN CHỌN ẢNH:`,
      `• Thả tim (♥) vào ảnh anh/chị chọn chỉnh sửa${limit > 0 ? ` (định mức: ${limit} ảnh)` : ''}.`,
      `• Bấm hình ngôi sao (★) cho ảnh muốn in phóng lớn/ảnh cổng.`,
      `• Có thể ghi chú trực tiếp yêu cầu (bóp mặt, chỉnh sáng...) ngay dưới từng ảnh.`,
      `• Sử dụng tính năng "Lọc theo khuôn mặt" để tìm ảnh nhanh chóng.`,
      `• Chọn xong, anh/chị bấm "Gửi danh sách" ở thanh dưới cùng nhé!`,
      ``,
      `Cần hỗ trợ anh/chị liên hệ hotline: ${STUDIO_CONFIG.studioHotline} nha. Em cảm ơn anh/chị! ❤️`,
    ].join('\n');

    if (this.resultShortUrl) this.resultShortUrl.value = shortUrl;
    if (this.resultUrl) this.resultUrl.value = fullUrl;
    if (this.resultMsg) this.resultMsg.value = msgTemplate;
    this.resultWrap.classList.remove('hidden');

    const historyItem = {
      folderId,
      client,
      pkg,
      slug,
      limit,
      download,
      shortUrl,
      link: fullUrl,
      updatedAt: Date.now(),
      time: new Date().toLocaleDateString('vi-VN'),
    };

    const isEdit = this.editingIndex >= 0;
    this.saveHistory(historyItem);

    if (isEdit) {
      if (this.editingBanner) this.editingBanner.classList.add('hidden');
      if (this.formTitle) this.formTitle.textContent = '1. Thông tin hợp đồng & Drive';
      if (this.btnGenerate) this.btnGenerate.textContent = 'Tạo Link & Lời Nhắn Mẫu';
    }

    this.resultWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  showButtonFeedback(btn, message) {
    const originalText = btn.textContent;
    btn.textContent = message;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1800);
  }

  renderHistory() {
    if (!this.historyListEl) return;
    this.historyListEl.innerHTML = '';

    let list = this.history;
    if (this.historySearchQuery) {
      list = list.filter(
        (item) =>
          item.client.toLowerCase().includes(this.historySearchQuery) ||
          item.pkg.toLowerCase().includes(this.historySearchQuery) ||
          (item.slug && item.slug.toLowerCase().includes(this.historySearchQuery)) ||
          item.folderId.toLowerCase().includes(this.historySearchQuery)
      );
    }

    if (this.historyCountEl) {
      this.historyCountEl.textContent = this.history.length;
    }

    if (list.length === 0) {
      this.historyListEl.innerHTML =
        '<p style="font-size:12px;color:var(--ink-muted);margin:0;padding:8px 0;">Không tìm thấy link nào.</p>';
      return;
    }

    list.forEach((item, index) => {
      const realIndex = this.history.indexOf(item);
      const isCurrentlyEditing = this.editingIndex === realIndex;
      const slugDisplay = item.slug ? `?k=${item.slug}` : '';

      // Đọc nháp xem khách đã chọn được bao nhiêu ảnh
      let selCountText = '';
      try {
        const draft = JSON.parse(localStorage.getItem(`studio_select_${item.folderId}`)) || {};
        const count = Object.keys(draft).filter((k) => draft[k].selected).length;
        if (count > 0) {
          selCountText = `<span style="font-size:11px;padding:2px 7px;border-radius:10px;background:rgba(239,68,68,0.12);color:#EF4444;font-weight:600;margin-left:6px;">♥ ${count} ảnh</span>`;
        }
      } catch (e) {
        // ignore
      }

      const div = document.createElement('div');
      div.className = 'history-item';
      if (isCurrentlyEditing) {
        div.style.borderColor = '#D97706';
        div.style.background = 'rgba(245, 158, 11, 0.06)';
      }

      div.innerHTML = `
        <div class="history-item-header">
          <div style="min-width:0;flex:1;">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;">
              <strong style="color:var(--ink-primary);font-size:13.5px;">${item.client}</strong>
              <span style="font-size:11px;color:var(--ink-secondary);padding:1px 6px;background:var(--border-hairline);border-radius:4px;">${item.pkg}</span>
              ${selCountText}
            </div>
            <div style="font-size:11px;color:var(--ink-muted);margin-top:3px;font-family:monospace;">
              ${slugDisplay ? `<span style="color:var(--accent-success);font-weight:600;">${slugDisplay}</span> • ` : ''}ID: ${item.folderId.substring(0, 16)}... • ${item.time}
            </div>
          </div>
        </div>

        <div class="history-item-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="edit" title="Chỉnh sửa thông tin link này" style="font-weight:600;">
            ✏️ Sửa
          </button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="copy-link" title="Sao chép link gửi khách">
            📋 Copy Link
          </button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="copy-zalo" title="Sao chép lời nhắn Zalo mẫu">
            💬 Tin Zalo
          </button>
          <button type="button" class="btn btn-primary btn-sm" data-action="open" title="Mở trực tiếp link này">
            👁️ Mở
          </button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="delete" title="Xóa link khỏi lịch sử" style="color:var(--accent-heart);margin-left:auto;">
            ✕
          </button>
        </div>
      `;

      // Nút Chỉnh sửa
      div.querySelector('[data-action="edit"]').addEventListener('click', () => {
        this.startEdit(realIndex);
      });

      // Nút Copy link
      const btnCopyLink = div.querySelector('[data-action="copy-link"]');
      btnCopyLink.addEventListener('click', () => {
        const targetUrl = item.shortUrl || item.link;
        navigator.clipboard.writeText(targetUrl);
        this.showButtonFeedback(btnCopyLink, 'Đã chép!');
      });

      // Nút Copy Zalo
      const btnCopyZalo = div.querySelector('[data-action="copy-zalo"]');
      btnCopyZalo.addEventListener('click', () => {
        const targetUrl = item.shortUrl || item.link;
        const msg = [
          `Dạ em chào anh/chị ${item.client}! ✨`,
          `${STUDIO_CONFIG.studioName} gửi anh/chị link xem và chọn ảnh cho gói "${item.pkg.replace(/_/g, ' ')}":`,
          `👉 ${targetUrl}`,
          ``,
          `📌 Anh/chị thả tim (♥) vào ảnh ưng ý và bấm "Gửi danh sách" ở dưới cùng nhé! ❤️`,
        ].join('\n');
        navigator.clipboard.writeText(msg);
        this.showButtonFeedback(btnCopyZalo, 'Đã chép!');
      });

      // Nút Mở album
      div.querySelector('[data-action="open"]').addEventListener('click', () => {
        window.location.href = item.shortUrl || item.link;
      });

      // Nút Xóa
      div.querySelector('[data-action="delete"]').addEventListener('click', () => {
        if (confirm(`Bạn có chắc muốn xóa link của khách "${item.client}" khỏi danh sách?`)) {
          this.deleteHistoryItem(realIndex);
        }
      });

      this.historyListEl.appendChild(div);
    });
  }
}
