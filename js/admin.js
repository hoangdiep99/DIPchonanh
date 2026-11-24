/**
 * Phân hệ 4.5: Quản trị Tạo Link, Chỉnh Sửa & Quản Lý Album Cho Studio (#admin)
 * - Đăng nhập cá nhân tiện lợi (Ghi nhớ vĩnh viễn trên máy tính này, mở nhanh 1-chạm).
 * - Chỉnh sửa trực tiếp các link đã tạo (đổi tên, link drive, gói chụp, định mức).
 * - Sinh đường link siêu ngắn gọn theo tên khách (Ví dụ: ?k=namlinh hoặc ?k=doicuoi).
 * - Thao tác 1-chạm ngay trên từng card: Copy Link, Copy Zalo, Chỉnh sửa, Mở, Xóa.
 */
import { STUDIO_CONFIG } from '../config.js?v=10.15';
import { extractDriveFolderId, loadDriveAlbum } from './drive.js?v=10.15';
import { FaceFilterEngine } from './face-filter.js?v=10.15';

const ADMIN_STORAGE_KEY = 'studio_admin_history';
const ADMIN_DELETED_KEY = 'studio_admin_deleted_albums';
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

  loadDeletedMap() {
    try {
      const raw = JSON.parse(localStorage.getItem(ADMIN_DELETED_KEY));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  saveDeletedMap(map) {
    try {
      localStorage.setItem(ADMIN_DELETED_KEY, JSON.stringify(map || {}));
    } catch {
      // ignore
    }
  }

  isDeletedItem(item, deletedMap) {
    if (!item || !deletedMap) return false;
    const itemTs = item.updatedAt || 0;
    const keys = [item.folderId, item.slug].filter(Boolean).map((k) => k.toString().toLowerCase().trim());
    for (const k of keys) {
      if (deletedMap[k] && deletedMap[k] >= itemTs) {
        return true;
      }
    }
    return false;
  }

  loadHistory() {
    const deletedMap = this.loadDeletedMap();
    let saved = [];
    try {
      const raw = JSON.parse(localStorage.getItem(ADMIN_STORAGE_KEY)) || [];
      saved = raw.filter((item) => item && !item.__deleted && !this.isDeletedItem(item, deletedMap));
    } catch {
      saved = [];
    }

    const defaultAlbums = STUDIO_CONFIG.defaultAlbums || [
      {
        folderId: '17cOYU7FhxtOs9yTw_RbZs_fj9yAdepTI',
        client: 'doi cuoi tu son 21',
        pkg: 'Album Tiêu Chuẩn',
        slug: 'doi-cuoi-tu-son-21',
        limit: 0,
        download: 1,
        time: 'Album hiện tại',
      },
    ];

    const baseOrigin = window.location.origin + window.location.pathname;
    let hasNew = false;
    for (const def of defaultAlbums) {
      const defWithTs = { ...def, updatedAt: 1 };
      if (this.isDeletedItem(defWithTs, deletedMap)) continue;
      if (!saved.some((item) => item.folderId === def.folderId || (def.slug && item.slug === def.slug))) {
        saved.push({
          ...def,
          shortUrl: `${baseOrigin}?k=${encodeURIComponent(def.slug)}&f=${encodeURIComponent(def.folderId)}`,
          link: `${baseOrigin}?k=${encodeURIComponent(def.slug)}&f=${encodeURIComponent(def.folderId)}`,
          updatedAt: 1,
        });
        hasNew = true;
      }
    }

    // Tự động kiểm tra URL hiện tại nếu đang mở một album
    const params = new URLSearchParams(window.location.search);
    const curFolder = params.get('folder') || params.get('f');
    const curSlug = params.get('k') || params.get('album');
    const curClient = params.get('khach') || curSlug || 'doi cuoi tu son 21';
    if (curFolder && !saved.some((item) => item.folderId === curFolder || (curSlug && item.slug === curSlug))) {
      const candidate = { folderId: curFolder, slug: curSlug || toSlug(curClient), updatedAt: 1 };
      if (!this.isDeletedItem(candidate, deletedMap)) {
        saved.push({
          folderId: curFolder,
          client: curClient.replace(/[-_]+/g, ' '),
          pkg: params.get('goi') || 'Album Tiêu Chuẩn',
          slug: curSlug || toSlug(curClient),
          limit: parseInt(params.get('limit'), 10) || 0,
          download: params.get('download') !== '0' ? 1 : 0,
          shortUrl: `${baseOrigin}?k=${encodeURIComponent(curSlug || toSlug(curClient))}&f=${encodeURIComponent(curFolder)}`,
          link: `${baseOrigin}?k=${encodeURIComponent(curSlug || toSlug(curClient))}&f=${encodeURIComponent(curFolder)}`,
          updatedAt: Date.now(),
          time: 'Album hiện tại',
        });
        hasNew = true;
      }
    }

    if (hasNew) {
      try {
        localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(saved));
      } catch {
        // ignore
      }
    }

    return saved;
  }

  async syncAdminHistoryToCloud(showFeedback = false) {
    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
    if (!webhookUrl) {
      if (showFeedback) alert('Chưa cấu hình Google Apps Script Webhook trong config.js!');
      return;
    }

    if (showFeedback && this.btnSaveCloud) {
      this.btnSaveCloud.disabled = true;
      this.btnSaveCloud.textContent = '⏳ Đang lưu...';
    }

    const deletedMap = this.loadDeletedMap();
    const tombstones = Object.entries(deletedMap).map(([key, ts]) => ({
      __deleted: true,
      key,
      folderId: key,
      slug: key,
      updatedAt: ts,
    }));

    const payloadList = [...(Array.isArray(this.history) ? this.history : []), ...tombstones];

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_admin_history',
          history: payloadList,
        }),
      });
      if (showFeedback && this.btnSaveCloud) {
        this.btnSaveCloud.textContent = '✅ Đã lưu Cloud';
        setTimeout(() => {
          if (this.btnSaveCloud) {
            this.btnSaveCloud.textContent = '💾 Lưu đồng bộ';
            this.btnSaveCloud.disabled = false;
          }
        }, 2000);
      }
    } catch (e) {
      console.warn('Lỗi đồng bộ lịch sử admin lên Cloud:', e);
      if (showFeedback && this.btnSaveCloud) {
        this.btnSaveCloud.textContent = '⚠️ Lỗi lưu';
        setTimeout(() => {
          if (this.btnSaveCloud) {
            this.btnSaveCloud.textContent = '💾 Lưu đồng bộ';
            this.btnSaveCloud.disabled = false;
          }
        }, 2000);
      }
    }
  }

  async syncAdminHistoryFromCloud(showToast = false) {
    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
    if (!webhookUrl) {
      if (showToast) alert('Chưa cấu hình Google Apps Script Webhook trong config.js!');
      return;
    }

    if (showToast && this.btnSyncCloud) {
      this.btnSyncCloud.disabled = true;
      this.btnSyncCloud.textContent = '⏳ Đang tải...';
    }

    try {
      const resp = await fetch(`${webhookUrl}?action=get_admin_history&_t=${Date.now()}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data && data.status === 'success' && Array.isArray(data.history) && data.history.length > 0) {
        const cloudDeletedMap = {};
        const cloudActive = [];

        for (const entry of data.history) {
          if (!entry) continue;
          if (entry.__deleted) {
            const k = (entry.key || entry.folderId || entry.slug || '').toString().toLowerCase().trim();
            if (k) cloudDeletedMap[k] = entry.updatedAt || Date.now();
          } else if (entry.folderId || entry.slug) {
            cloudActive.push(entry);
          }
        }

        // Đám mây là nguồn chuẩn duy nhất: đồng bộ chính xác danh sách (kể cả các mục đã xóa từ thiết bị khác)
        this.history = cloudActive.slice(0, 50);
        this.saveDeletedMap(cloudDeletedMap);
        try {
          localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(this.history));
        } catch {}
        this.renderHistory();

        if (showToast && this.btnSyncCloud) {
          this.btnSyncCloud.textContent = '✅ Đã đồng bộ';
          setTimeout(() => {
            if (this.btnSyncCloud) {
              this.btnSyncCloud.textContent = '☁️ Tải từ Cloud';
              this.btnSyncCloud.disabled = false;
            }
          }, 2000);
        }
      } else {
        if (this.history.length > 0 || Object.keys(this.loadDeletedMap()).length > 0) {
          this.syncAdminHistoryToCloud(false);
        }
        if (showToast && this.btnSyncCloud) {
          this.btnSyncCloud.textContent = '☁️ Tải từ Cloud';
          this.btnSyncCloud.disabled = false;
        }
      }
    } catch (err) {
      console.warn('Lỗi khi tải lịch sử admin từ Cloud:', err);
      if (this.history.length > 0) {
        this.syncAdminHistoryToCloud(false);
      }
      if (showToast && this.btnSyncCloud) {
        this.btnSyncCloud.textContent = '⚠️ Lỗi đồng bộ';
        setTimeout(() => {
          if (this.btnSyncCloud) {
            this.btnSyncCloud.textContent = '☁️ Đồng bộ Cloud';
            this.btnSyncCloud.disabled = false;
          }
        }, 2000);
      }
    }
  }

  saveHistory(item) {
    item.updatedAt = Date.now();
    // Gỡ trạng thái đã xóa nếu tạo lại album cùng folderId hoặc slug
    const deletedMap = this.loadDeletedMap();
    const keys = [item.folderId, item.slug].filter(Boolean).map((k) => k.toString().toLowerCase().trim());
    let unDeleted = false;
    for (const k of keys) {
      if (deletedMap[k]) {
        delete deletedMap[k];
        unDeleted = true;
      }
    }
    if (unDeleted) this.saveDeletedMap(deletedMap);

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
    this.syncAdminHistoryToCloud(true);
  }

  deleteHistoryItem(index) {
    const removed = this.history[index];
    this.history.splice(index, 1);

    if (removed) {
      const deletedMap = this.loadDeletedMap();
      const now = Date.now();
      if (removed.folderId) deletedMap[removed.folderId.toString().toLowerCase().trim()] = now;
      if (removed.slug) deletedMap[removed.slug.toString().toLowerCase().trim()] = now;
      this.saveDeletedMap(deletedMap);
    }

    try {
      localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(this.history));
    } catch {
      // ignore
    }
    this.renderHistory();
    this.syncAdminHistoryToCloud(true);
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
      this.history = this.loadHistory();
      this.renderPresets();
      this.renderHistory();
      this.syncAdminHistoryFromCloud(false);
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

  async handleLogin() {
    const p = this.passwordInput?.value ? this.passwordInput.value.trim() : '';
    const u = this.usernameInput?.value
      ? this.usernameInput.value.trim().toLowerCase()
      : (STUDIO_CONFIG.adminAuth?.username || 'hoangdiep').toLowerCase();

    if (!p) return;

    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
    const submitBtn = this.loginForm?.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn ? submitBtn.textContent : '';

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '⏳ Đang xác thực bảo mật...';
    }
    this.loginErrorMsg?.classList.add('hidden');

    try {
      if (!webhookUrl) {
        throw new Error('Chưa cấu hình Google Apps Script Webhook để xác thực!');
      }

      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'admin_login',
          username: u,
          password: p,
        }),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();

      if (json && json.authenticated === true) {
        const remember = this.rememberCheckbox ? this.rememberCheckbox.checked : true;
        this.grantAccess(remember);
        return;
      }

      if (json && json.authenticated === false) {
        if (this.loginErrorMsg) {
          this.loginErrorMsg.textContent = json.message || 'Mã PIN hoặc mật khẩu không chính xác!';
          this.loginErrorMsg.classList.remove('hidden');
        }
      } else {
        if (this.loginErrorMsg) {
          this.loginErrorMsg.textContent =
            'Google Apps Script chưa cập nhật bản xác thực mới. Vui lòng dán Code.gs mới và Triển khai phiên bản mới!';
          this.loginErrorMsg.classList.remove('hidden');
        }
      }

      if (this.passwordInput) {
        this.passwordInput.value = '';
        this.passwordInput.focus();
      }
    } catch (err) {
      console.error('Lỗi xác thực đăng nhập Admin:', err);
      if (this.loginErrorMsg) {
        this.loginErrorMsg.textContent = 'Không thể kết nối máy chủ xác thực Google. Vui lòng thử lại!';
        this.loginErrorMsg.classList.remove('hidden');
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText || 'Mở Bảng Quản Trị Studio';
      }
    }
  }

  handleLogout() {
    localStorage.removeItem(ADMIN_REMEMBER_KEY);
    sessionStorage.removeItem('studio_admin_session');
    this.checkAuthState();
  }

  async handleChangePassword() {
    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
    if (!webhookUrl) {
      alert('Chưa cấu hình Google Apps Script Webhook!');
      return;
    }

    const oldInput = prompt('Nhập mật khẩu hiện tại của bạn:', '');
    if (oldInput === null) return;
    const newPass = prompt('Nhập mật khẩu mới muốn đặt (tối thiểu 4 ký tự):', '');
    if (newPass === null) return;
    if (!newPass.trim() || newPass.trim().length < 4) {
      alert('Mật khẩu mới phải có ít nhất 4 ký tự!');
      return;
    }
    const confirmPass = prompt('Nhập lại mật khẩu mới để xác nhận:', '');
    if (confirmPass !== newPass) {
      alert('Mật khẩu xác nhận không khớp!');
      return;
    }

    try {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'admin_change_pass',
          oldPassword: oldInput.trim(),
          newPassword: newPass.trim(),
        }),
      });
      const json = await resp.json();
      if (json && json.status === 'success') {
        localStorage.removeItem(ADMIN_CUSTOM_PASS_KEY);
        alert('✅ Đã đổi mật khẩu Studio trên Đám mây thành công! Áp dụng ngay cho mọi thiết bị (máy tính & điện thoại).');
      } else {
        alert(`⚠️ ${json?.message || 'Không thể đổi mật khẩu. Hãy chắc chắn bạn đã cập nhật Code.gs mới lên Google Apps Script!'}`);
      }
    } catch (err) {
      console.error('Lỗi đổi mật khẩu:', err);
      alert('⚠️ Lỗi kết nối máy chủ Google khi đổi mật khẩu. Vui lòng thử lại!');
    }
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
    this.shootDateInput = this.container.querySelector('#admin-shoot-date');
    this.downloadToggle = this.container.querySelector('#admin-download-toggle');
    this.publicToggle = this.container.querySelector('#admin-public-toggle');
    this.presetChipsEl = this.container.querySelector('#admin-preset-chips');

    // Đặt ngày mặc định cho ô Ngày chụp
    if (this.shootDateInput && !this.shootDateInput.value) {
      this.shootDateInput.value = new Date().toLocaleDateString('vi-VN');
    }

    // Thống kê tổng quan Admin Stats Bar
    this.statAlbumsEl = this.container.querySelector('#admin-stat-albums');
    this.statPublicEl = this.container.querySelector('#admin-stat-public');
    this.statSelectedEl = this.container.querySelector('#admin-stat-selected');
    this.statCloudEl = this.container.querySelector('#admin-stat-cloud');

    // Modal Chọn Ảnh Bìa Album
    this.coverModal = this.container.querySelector('#admin-cover-modal');
    this.coverBackdrop = this.container.querySelector('#admin-cover-backdrop');
    this.coverCloseBtn = this.container.querySelector('#admin-cover-close');
    this.coverModalTitle = this.container.querySelector('#admin-cover-modal-title');
    this.coverSearchInput = this.container.querySelector('#admin-cover-search');
    this.coverCountEl = this.container.querySelector('#admin-cover-count');
    this.coverStatusEl = this.container.querySelector('#admin-cover-status');
    this.coverStatusText = this.container.querySelector('#admin-cover-status-text');
    this.coverGridEl = this.container.querySelector('#admin-cover-grid');
    this.coverMoreWrap = this.container.querySelector('#admin-cover-more-wrap');
    this.coverLoadMoreBtn = this.container.querySelector('#admin-cover-load-more');

    const closeCoverModal = () => this.coverModal?.classList.add('hidden');
    this.coverCloseBtn?.addEventListener('click', closeCoverModal);
    this.coverBackdrop?.addEventListener('click', closeCoverModal);
    this.coverSearchInput?.addEventListener('input', () => {
      this.coverPickerLimit = 60;
      this.renderCoverPickerGrid();
    });
    this.coverLoadMoreBtn?.addEventListener('click', () => {
      this.coverPickerLimit = (this.coverPickerLimit || 60) + 60;
      this.renderCoverPickerGrid();
    });

    // Modal Xem & Copy Mã Ảnh Khách Đã Chọn
    this.selectedModal = this.container.querySelector('#admin-selected-modal');
    this.selectedBackdrop = this.container.querySelector('#admin-selected-backdrop');
    this.selectedCloseBtn = this.container.querySelector('#admin-selected-close');
    this.selectedModalTitle = this.container.querySelector('#admin-selected-modal-title');
    this.selectedModalSub = this.container.querySelector('#admin-selected-modal-sub');
    this.selectedStatusEl = this.container.querySelector('#admin-selected-status');
    this.selectedStatusText = this.container.querySelector('#admin-selected-status-text');
    this.selectedContentEl = this.container.querySelector('#admin-selected-content');
    this.selectedSummaryEl = this.container.querySelector('#admin-selected-summary');
    this.selectedCodesText = this.container.querySelector('#admin-selected-codes-text');
    this.selectedListEl = this.container.querySelector('#admin-selected-list');
    this.btnCopyLR = this.container.querySelector('#admin-btn-copy-lr');
    this.btnCopyNums = this.container.querySelector('#admin-btn-copy-nums');
    this.btnCopyDetail = this.container.querySelector('#admin-btn-copy-detail');

    const closeSelectedModal = () => this.selectedModal?.classList.add('hidden');
    this.selectedCloseBtn?.addEventListener('click', closeSelectedModal);
    this.selectedBackdrop?.addEventListener('click', closeSelectedModal);

    this.btnCopyLR?.addEventListener('click', () => {
      if (this.currentSelectedLRText) {
        navigator.clipboard.writeText(this.currentSelectedLRText);
        this.showButtonFeedback(this.btnCopyLR, '✅ Đã copy mã Lightroom!');
      }
    });
    this.btnCopyNums?.addEventListener('click', () => {
      if (this.currentSelectedNumsText) {
        navigator.clipboard.writeText(this.currentSelectedNumsText);
        this.showButtonFeedback(this.btnCopyNums, '✅ Đã copy số cuối!');
      }
    });
    this.btnCopyDetail?.addEventListener('click', () => {
      if (this.currentSelectedDetailText) {
        navigator.clipboard.writeText(this.currentSelectedDetailText);
        this.showButtonFeedback(this.btnCopyDetail, '✅ Đã copy chi tiết!');
      }
    });

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
    this.btnSyncCloud = this.container.querySelector('#admin-history-sync-cloud-btn');
    this.btnSaveCloud = this.container.querySelector('#admin-history-save-cloud-btn');

    this.btnSyncCloud?.addEventListener('click', () => {
      this.syncAdminHistoryFromCloud(true);
    });

    this.btnSaveCloud?.addEventListener('click', () => {
      this.syncAdminHistoryToCloud(true);
    });

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

    // Panel Tiến trình Quét & Nhận diện Khuôn mặt AI
    this.aiScanBox = this.container.querySelector('#admin-ai-scan-box');
    this.scanBadge = this.container.querySelector('#admin-scan-badge');
    this.scanBar = this.container.querySelector('#admin-scan-bar');
    this.scanStatusText = this.container.querySelector('#admin-scan-status-text');
    this.scanPercent = this.container.querySelector('#admin-scan-percent');
    this.scanResultRow = this.container.querySelector('#admin-scan-result-row');
    this.scanChipsList = this.container.querySelector('#admin-scan-chips-list');
    this.scanOpenAlbumBtn = this.container.querySelector('#admin-scan-open-album-btn');
    this.scanRestartBtn = this.container.querySelector('#admin-scan-restart-btn');

    this.adminScanBtnStart = this.container.querySelector('#admin-scan-btn-start');
    this.adminScanBtnPause = this.container.querySelector('#admin-scan-btn-pause');
    this.adminScanBtnResume = this.container.querySelector('#admin-scan-btn-resume');
    this.adminScanBtnStop = this.container.querySelector('#admin-scan-btn-stop');

    this.adminScanBtnStart?.addEventListener('click', () => {
      if (this.currentScanningFolderId) {
        this.startAutoScanForAlbum(this.currentScanningFolderId, this.currentScanningSlug, true);
      }
    });

    this.adminScanBtnPause?.addEventListener('click', () => {
      this.faceEngine?.pauseScan();
      this.updateAdminScanControls('paused');
      if (this.scanBadge) {
        this.scanBadge.textContent = 'Tạm dừng';
        this.scanBadge.style.background = '#fef3c7';
        this.scanBadge.style.color = '#b45309';
      }
      if (this.scanStatusText) this.scanStatusText.textContent = '⏸️ Đã tạm dừng quét AI. Bấm "Tiếp tục" để chạy tiếp.';
    });

    this.adminScanBtnResume?.addEventListener('click', () => {
      this.faceEngine?.resumeScan();
      this.updateAdminScanControls('running');
      if (this.scanBadge) {
        this.scanBadge.textContent = 'Đang quét AI...';
        this.scanBadge.style.background = '#e0f2fe';
        this.scanBadge.style.color = '#0284c7';
      }
      if (this.scanStatusText) this.scanStatusText.textContent = '▶️ Đang tiếp tục quét...';
    });

    this.adminScanBtnStop?.addEventListener('click', () => {
      this.faceEngine?.stopScan();
      this.updateAdminScanControls('idle');
      if (this.scanStatusText) this.scanStatusText.textContent = '⏹️ Đang dừng quét và gom nhóm các ảnh đã phân tích...';
    });

    this.scanRestartBtn?.addEventListener('click', () => {
      if (this.currentScanningFolderId) {
        this.startAutoScanForAlbum(this.currentScanningFolderId, this.currentScanningSlug, true);
      }
    });
  }

  updateAdminScanControls(state) {
    if (state === 'running') {
      this.adminScanBtnStart?.classList.add('hidden');
      this.adminScanBtnPause?.classList.remove('hidden');
      this.adminScanBtnResume?.classList.add('hidden');
      this.adminScanBtnStop?.classList.remove('hidden');
    } else if (state === 'paused') {
      this.adminScanBtnStart?.classList.add('hidden');
      this.adminScanBtnPause?.classList.add('hidden');
      this.adminScanBtnResume?.classList.remove('hidden');
      this.adminScanBtnStop?.classList.remove('hidden');
    } else {
      this.adminScanBtnStart?.classList.remove('hidden');
      this.adminScanBtnPause?.classList.add('hidden');
      this.adminScanBtnResume?.classList.add('hidden');
      this.adminScanBtnStop?.classList.add('hidden');
    }
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
        if (this.packageInput) this.packageInput.value = preset.value;
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
    if (this.packageInput) this.packageInput.value = item.pkg || '';
    this.shortSlugInput.value = item.slug || toSlug(item.client);
    this.limitInput.value = item.limit || '';
    if (this.shootDateInput) this.shootDateInput.value = item.time || new Date().toLocaleDateString('vi-VN');
    this.downloadToggle.checked = item.download === 1;
    if (this.publicToggle) this.publicToggle.checked = item.isPublic !== false;

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
    if (this.packageInput) this.packageInput.value = '';
    this.shortSlugInput.value = '';
    this.limitInput.value = '';
    if (this.shootDateInput) this.shootDateInput.value = new Date().toLocaleDateString('vi-VN');
    this.downloadToggle.checked = true;
    if (this.publicToggle) this.publicToggle.checked = true;
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
    const pkg = (this.packageInput?.value || '').trim() || 'Album Tiêu Chuẩn';
    const slug = (this.shortSlugInput.value.trim() || toSlug(client)).toLowerCase();
    const limit = parseInt(this.limitInput.value, 10) || 0;
    const download = this.downloadToggle.checked ? 1 : 0;

    const baseOrigin = window.location.origin + window.location.pathname;

    // 1. Link ngắn gọn siêu đẹp theo tên khách (Siêu ngắn, tiện gửi Zalo)
    let shortUrl = `${baseOrigin}?k=${encodeURIComponent(slug)}`;
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

    const existingItem =
      (this.editingIndex >= 0 && this.history[this.editingIndex]) ||
      this.history.find((h) => h.folderId === folderId) ||
      null;
    const shootDate = (this.shootDateInput?.value || '').trim() || new Date().toLocaleDateString('vi-VN');
    const isPublic = this.publicToggle ? this.publicToggle.checked : true;

    const historyItem = {
      ...(existingItem ? {
        coverUrl: existingItem.coverUrl,
        coverFallbackUrl: existingItem.coverFallbackUrl,
        coverPhotoId: existingItem.coverPhotoId,
        photoCount: existingItem.photoCount,
      } : {}),
      folderId,
      client,
      pkg,
      slug,
      limit,
      download,
      isPublic,
      shortUrl,
      link: fullUrl,
      updatedAt: Date.now(),
      time: shootDate,
    };

    const isEdit = this.editingIndex >= 0;
    this.saveHistory(historyItem);

    // Tự động đẩy danh bạ album lên Webhook Google Sheets
    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
    if (webhookUrl) {
      try {
        fetch(webhookUrl, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'save_album',
            slug,
            albumData: { folderId, client, pkg, limit, download }
          })
        }).catch(() => {});
      } catch (e) {
        // ignore
      }
    }

    if (isEdit) {
      if (this.editingBanner) this.editingBanner.classList.add('hidden');
      if (this.formTitle) this.formTitle.textContent = '1. Thông tin hợp đồng & Drive';
      if (this.btnGenerate) this.btnGenerate.textContent = 'Tạo Link & Lời Nhắn Mẫu';
    }

    this.resultWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Tự động kích hoạt AI quét & nhận diện khuôn mặt cho album này ngay lập tức
    this.startAutoScanForAlbum(folderId, slug);
  }

  // --- HỆ THỐNG AI TỰ ĐỘNG QUÉT & GOM NHÓM KHUÔN MẶT TRONG ADMIN ---
  async startAutoScanForAlbum(folderId, slug, force = false) {
    if (!folderId) return;
    this.currentScanningFolderId = folderId;
    this.currentScanningSlug = slug;

    if (!this.aiScanBox) return;
    this.aiScanBox.classList.remove('hidden');
    if (this.scanResultRow) this.scanResultRow.classList.add('hidden');
    if (this.scanChipsList) this.scanChipsList.innerHTML = '';

    // Kiểm tra xem đã có cache sẵn chưa (nếu không bấm quét lại)
    const existingCache = localStorage.getItem(`studio_clusters_${folderId}`) || (slug ? localStorage.getItem(`studio_clusters_${slug}`) : null);
    if (existingCache && !force) {
      try {
        const clusters = JSON.parse(existingCache);
        if (Array.isArray(clusters) && clusters.length > 0) {
          this.renderScanSuccess(clusters, slug);
          return;
        }
      } catch (e) {}
    }

    this.isScanning = true;
    this.updateAdminScanControls('running');
    if (this.scanBadge) {
      this.scanBadge.textContent = 'Đang quét AI...';
      this.scanBadge.style.background = '#e0f2fe';
      this.scanBadge.style.color = '#0284c7';
    }
    if (this.scanBar) this.scanBar.style.width = '10%';
    if (this.scanPercent) this.scanPercent.textContent = '10%';
    if (this.scanStatusText) this.scanStatusText.textContent = '📡 Đang kết nối Google Drive tải danh sách ảnh...';

    try {
      // 1. Tải danh sách ảnh từ Google Drive
      const albumData = await loadDriveAlbum(
        folderId,
        STUDIO_CONFIG.googleDriveApiKey,
        (msg) => {
          if (this.scanStatusText && typeof msg === 'string') this.scanStatusText.textContent = msg;
        },
        true
      );
      const photos = albumData.photos || [];

      if (photos.length === 0) {
        if (this.scanBadge) {
          this.scanBadge.textContent = 'Không có ảnh';
          this.scanBadge.style.background = '#fee2e2';
          this.scanBadge.style.color = '#dc2626';
        }
        if (this.scanBar) this.scanBar.style.width = '100%';
        if (this.scanPercent) this.scanPercent.textContent = '100%';
        if (this.scanStatusText) this.scanStatusText.textContent = '⚠️ Thư mục Google Drive này chưa có file ảnh nào.';
        this.isScanning = false;
        this.updateAdminScanControls('idle');
        return;
      }

      if (this.scanBar) this.scanBar.style.width = '20%';
      if (this.scanPercent) this.scanPercent.textContent = '20%';
      if (this.scanStatusText) this.scanStatusText.textContent = `✅ Tìm thấy ${photos.length} ảnh. Đang khởi động AI...`;

      // 2. Khởi tạo FaceFilterEngine
      if (!this.faceEngine) {
        this.faceEngine = new FaceFilterEngine();
      }
      await this.faceEngine.initHuman();

      if (this.scanBar) this.scanBar.style.width = '25%';
      if (this.scanPercent) this.scanPercent.textContent = '25%';

      // 3. Tiến hành quét từng ảnh và gom cụm nhân vật
      const clusters = await this.faceEngine.scanAndClusterAlbum(
        photos,
        (progress) => {
          const total = progress.total || photos.length || 1;
          const current = progress.current || 0;
          const faces = progress.foundFaces || 0;
          if (progress.phase === 'paused') {
            this.updateAdminScanControls('paused');
            if (this.scanBadge) {
              this.scanBadge.textContent = 'Tạm dừng';
              this.scanBadge.style.background = '#fef3c7';
              this.scanBadge.style.color = '#b45309';
            }
            if (this.scanStatusText) {
              this.scanStatusText.textContent = `⏸️ Đã tạm dừng quét (${current}/${total} ảnh). Bấm "Tiếp tục" để chạy tiếp.`;
            }
            return;
          }

          this.updateAdminScanControls('running');
          if (progress.phase === 'ai_scanning' || progress.phase === 'detecting') {
            const pct = 25 + Math.round((current / total) * 65);
            if (this.scanBar) this.scanBar.style.width = `${pct}%`;
            if (this.scanPercent) this.scanPercent.textContent = `${pct}%`;
            if (this.scanStatusText) {
              this.scanStatusText.textContent = `🔍 Đang quét khuôn mặt: ${current}/${total} ảnh (đã tìm thấy ${faces} mặt)...`;
            }
          } else if (progress.phase === 'cache_loaded') {
            const pct = 25 + Math.round((current / total) * 65);
            if (this.scanBar) this.scanBar.style.width = `${pct}%`;
            if (this.scanPercent) this.scanPercent.textContent = `${pct}%`;
            if (this.scanStatusText) {
              this.scanStatusText.textContent = `⚡ Đã nạp từ cache: ${current}/${total} ảnh (${faces} mặt)...`;
            }
          } else if (progress.phase === 'clustering') {
            if (this.scanBar) this.scanBar.style.width = '95%';
            if (this.scanPercent) this.scanPercent.textContent = '95%';
            if (this.scanStatusText) {
              this.scanStatusText.textContent = `🧩 Đang gom cụm và phân loại các nhân vật (${faces} khuôn mặt)...`;
            }
          }
        },
        STUDIO_CONFIG.faceAI.defaultThreshold || 0.52
      );

      // 4. Lưu kết quả vào LocalStorage & Đồng bộ lên Webhook
      const clusterData = clusters.map((c) => ({
        id: c.id,
        label: c.label,
        avatarUrl: c.avatarUrl,
        photoCount: c.photoCount,
        photoIds: Array.from(c.photoIds),
      }));

      localStorage.setItem(`studio_clusters_${folderId}`, JSON.stringify(clusterData));
      if (slug) {
        localStorage.setItem(`studio_clusters_${slug}`, JSON.stringify(clusterData));
      }

      // Đẩy lên Webhook đám mây để mọi thiết bị của khách mở lên đều có ngay
      const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
      if (webhookUrl) {
        fetch(webhookUrl, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'save_clusters',
            folderId,
            slug,
            clusters: clusterData,
          }),
        }).catch(() => {});
      }

      // 5. Hiển thị kết quả thành công
      this.renderScanSuccess(clusterData, slug);
      this.renderHistory();
      this.isScanning = false;
      this.updateAdminScanControls('idle');
    } catch (err) {
      console.error('Lỗi khi quét AI khuôn mặt trong admin:', err);
      if (this.scanBadge) {
        this.scanBadge.textContent = 'Lỗi quét';
        this.scanBadge.style.background = '#fee2e2';
        this.scanBadge.style.color = '#dc2626';
      }
      if (this.scanStatusText) this.scanStatusText.textContent = `⚠️ Lỗi quét: ${err.message || 'Không thể hoàn tất'}`;
      this.isScanning = false;
      this.updateAdminScanControls('idle');
    }
  }

  renderScanSuccess(clusters, slug) {
    if (this.scanBar) this.scanBar.style.width = '100%';
    if (this.scanPercent) this.scanPercent.textContent = '100%';
    if (this.scanBadge) {
      this.scanBadge.textContent = `Xong (${clusters.length} người)`;
      this.scanBadge.style.background = '#dcfce7';
      this.scanBadge.style.color = '#15803d';
    }

    if (clusters.length === 0) {
      if (this.scanStatusText) this.scanStatusText.textContent = '✅ Đã quét xong, không phát hiện khuôn mặt rõ nét nào trong album.';
      if (this.scanResultRow) this.scanResultRow.classList.add('hidden');
      return;
    }

    if (this.scanStatusText) {
      this.scanStatusText.textContent = `🎉 Hoàn tất nhận diện! Đã tìm thấy ${clusters.length} nhân vật trong album.`;
    }
    if (this.scanResultRow) this.scanResultRow.classList.remove('hidden');
    if (this.scanChipsList) {
      this.scanChipsList.innerHTML = '';
      for (const c of clusters) {
        const chip = document.createElement('div');
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 10px 4px 4px;background:#fff;border:1px solid #cbd5e1;border-radius:20px;font-size:12px;';
        chip.innerHTML = `
          <img src="${c.avatarUrl}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;" alt="${c.label}">
          <strong>${c.label}</strong>
          <span style="color:#64748b;font-size:11px;">(${c.photoCount} ảnh)</span>
        `;
        this.scanChipsList.appendChild(chip);
      }
    }

    const baseOrigin = window.location.origin + window.location.pathname;
    const targetUrl = slug ? `${baseOrigin}?k=${encodeURIComponent(slug)}` : `${baseOrigin}?folder=${this.currentScanningFolderId}`;
    if (this.scanOpenAlbumBtn) {
      this.scanOpenAlbumBtn.href = targetUrl;
    }
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
      let selCount = 0;
      try {
        const draft = JSON.parse(localStorage.getItem(`studio_select_${item.folderId}`)) || {};
        selCount = Object.keys(draft).filter((k) => draft[k].selected).length;
      } catch (e) {
        // ignore
      }
      const selCountText = `<button type="button" data-action="view-selected" class="admin-sel-count-badge${selCount > 0 ? '' : ' hidden'}" style="border:none;cursor:pointer;font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(239,68,68,0.12);color:#EF4444;font-weight:700;margin-left:4px;" title="Bấm để xem & copy mã số ảnh khách đã chọn">♥ ${selCount} ảnh</button>`;

      // Kiểm tra trạng thái AI mặt của album này
      let aiStatusHtml = '';
      try {
        const clusterRaw = localStorage.getItem(`studio_clusters_${item.folderId}`) || (item.slug ? localStorage.getItem(`studio_clusters_${item.slug}`) : null);
        if (clusterRaw) {
          const cData = JSON.parse(clusterRaw);
          if (Array.isArray(cData) && cData.length > 0) {
            aiStatusHtml = `<span style="font-size:11px;padding:2px 7px;border-radius:10px;background:#dcfce7;color:#15803d;font-weight:600;margin-left:4px;">👥 ${cData.length} người</span>`;
          }
        }
      } catch (e) {}

      if (!aiStatusHtml) {
        aiStatusHtml = `<button type="button" class="btn btn-ghost btn-xs" data-action="scan-ai" style="font-size:11px;padding:1px 6px;color:#0284c7;background:#e0f2fe;border-radius:8px;margin-left:4px;" title="Chạy AI nhận diện khuôn mặt cho album này">⚡ Quét AI</button>`;
      }

      const div = document.createElement('div');
      div.className = 'history-item';
      if (isCurrentlyEditing) {
        div.style.borderColor = '#D97706';
        div.style.background = 'rgba(245, 158, 11, 0.06)';
      }

      // Đọc ảnh bìa hiện tại của album (từ item hoặc cache localStorage)
      let thumbUrl = item.coverUrl || '';
      if (!thumbUrl && item.folderId) {
        try {
          const cRaw = localStorage.getItem(`studio_album_cover_${item.folderId}`);
          if (cRaw) thumbUrl = JSON.parse(cRaw).coverUrl || '';
        } catch {}
      }

      const privacyBadge =
        item.isPublic === false
          ? `<span style="font-size:11px;padding:2px 7px;border-radius:10px;background:#fef3c7;color:#b45309;font-weight:600;">🔒 Ẩn Trang chủ</span>`
          : '';

      div.innerHTML = `
        <div class="history-item-header" style="display:flex;align-items:flex-start;gap:12px;">
          <div class="history-item-thumb-wrap" data-action="pick-cover" title="Bấm để chọn ảnh bìa đẹp nhất cho album này">
            ${thumbUrl ? `<img src="${thumbUrl}" class="history-item-thumb" alt="${item.client}" loading="lazy">` : `<span style="font-size:22px;opacity:0.5;">📸</span>`}
            <span class="history-item-thumb-overlay">Đổi bìa</span>
          </div>
          <div style="min-width:0;flex:1;">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;">
              <strong style="color:var(--ink-primary);font-size:13.5px;">${item.client}</strong>
              <span style="font-size:11px;color:var(--ink-secondary);padding:1px 6px;background:var(--border-hairline);border-radius:4px;">${item.pkg}</span>
              ${privacyBadge}
              ${selCountText}
              ${aiStatusHtml}
            </div>
            <div style="font-size:11px;color:var(--ink-muted);margin-top:4px;font-family:monospace;">
              ${slugDisplay ? `<span style="color:var(--accent-success);font-weight:600;">${slugDisplay}</span> • ` : ''}ID: ${item.folderId.substring(0, 14)}... • 📅 ${item.time}
            </div>
          </div>
        </div>

        <div class="history-item-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="view-selected" title="Xem & sao chép danh sách mã số ảnh khách đã chọn" style="color:#dc2626;border-color:rgba(239,68,68,0.3);background:rgba(239,68,68,0.05);font-weight:600;">
            ♥ Mã ảnh chọn
          </button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="pick-cover" title="Chọn 1 ảnh đẹp nhất trong album làm ảnh đại diện">
            🖼️ Ảnh bìa
          </button>
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

      // Nút Xem & Copy mã ảnh khách đã chọn
      div.querySelectorAll('[data-action="view-selected"]').forEach((el) => {
        el.addEventListener('click', () => {
          this.openSelectedCodesModal(item);
        });
      });

      // Tự động kéo số lượng ảnh khách đã chọn từ Đám mây (nếu khách chọn trên điện thoại của khách)
      const selBadgeEl = div.querySelector('.admin-sel-count-badge');
      this.refreshCloudSelectionCount(item.folderId, selBadgeEl);

      // Nút Chọn ảnh bìa (cả trên thumbnail lẫn nút bấm)
      div.querySelectorAll('[data-action="pick-cover"]').forEach((el) => {
        el.addEventListener('click', () => {
          this.openCoverPicker(realIndex);
        });
      });

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

      // Nút Quét AI
      div.querySelector('[data-action="scan-ai"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.driveInput.value = item.folderId;
        this.clientInput.value = item.client;
        if (this.packageInput) this.packageInput.value = item.pkg || '';
        if (this.shortSlugInput) this.shortSlugInput.value = item.slug || '';
        this.startAutoScanForAlbum(item.folderId, item.slug, true);
        this.aiScanBox?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

    this.updateAdminStats();
  }

  updateAdminStats() {
    const total = this.history.length;
    const publicCount = this.history.filter((h) => h.isPublic !== false).length;
    let totalSelected = 0;
    for (const item of this.history) {
      try {
        const draft = JSON.parse(localStorage.getItem(`studio_select_${item.folderId}`)) || {};
        totalSelected += Object.keys(draft).filter((k) => draft[k].selected).length;
      } catch {}
    }

    if (this.statAlbumsEl) this.statAlbumsEl.textContent = total;
    if (this.statPublicEl) this.statPublicEl.textContent = publicCount;
    if (this.statSelectedEl) this.statSelectedEl.textContent = totalSelected;
  }

  // --- BỘ CHỌN ẢNH BÌA ĐẸP NHẤT CHO TỪNG ALBUM ---
  async openCoverPicker(index) {
    const item = this.history[index];
    if (!item || !item.folderId || !this.coverModal) return;

    this.coverPickerIndex = index;
    this.coverPickerItem = item;
    this.coverPickerPhotos = [];
    this.coverPickerLimit = 60;

    if (this.coverModalTitle) {
      this.coverModalTitle.textContent = `🖼️ Chọn Ảnh Bìa — ${item.client}`;
    }
    if (this.coverSearchInput) this.coverSearchInput.value = '';
    if (this.coverGridEl) this.coverGridEl.innerHTML = '';
    if (this.coverMoreWrap) this.coverMoreWrap.classList.add('hidden');
    if (this.coverCountEl) this.coverCountEl.textContent = 'Đang tải...';
    if (this.coverStatusEl) this.coverStatusEl.classList.remove('hidden');
    if (this.coverStatusText) this.coverStatusText.textContent = 'Đang kết nối Google Drive tải danh sách ảnh...';

    this.coverModal.classList.remove('hidden');

    try {
      const data = await loadDriveAlbum(item.folderId, STUDIO_CONFIG.googleDriveApiKey, null, false);
      this.coverPickerPhotos = data?.photos || [];
      this.coverStatusEl?.classList.add('hidden');
      if (this.coverPickerPhotos.length === 0) {
        if (this.coverGridEl) {
          this.coverGridEl.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--ink-muted);padding:24px;">Không tìm thấy ảnh nào trong thư mục Google Drive này.</p>';
        }
        return;
      }
      this.renderCoverPickerGrid();
    } catch (err) {
      console.error('Lỗi tải ảnh chọn bìa:', err);
      if (this.coverStatusText) {
        this.coverStatusText.textContent = 'Không thể tải danh sách ảnh từ Google Drive. Vui lòng thử lại!';
      }
    }
  }

  renderCoverPickerGrid() {
    if (!this.coverGridEl) return;
    const q = (this.coverSearchInput?.value || '').trim().toLowerCase();
    const filtered = q
      ? this.coverPickerPhotos.filter((p) => (p.name || '').toLowerCase().includes(q))
      : this.coverPickerPhotos;

    if (this.coverCountEl) {
      this.coverCountEl.textContent = `${filtered.length} ảnh`;
    }

    const limit = this.coverPickerLimit || 60;
    const slice = filtered.slice(0, limit);
    const currentCoverId = this.coverPickerItem?.coverPhotoId || '';
    const currentCoverUrl = this.coverPickerItem?.coverUrl || '';

    this.coverGridEl.innerHTML = '';
    for (const photo of slice) {
      const thumbUrl = photo.gridUrl || photo.thumbnailLink || `https://drive.google.com/thumbnail?id=${photo.id}&sz=w800`;
      const fallbackUrl = `https://lh3.googleusercontent.com/d/${photo.id}=w800`;
      const isCurrent = (currentCoverId && currentCoverId === photo.id) || (currentCoverUrl && currentCoverUrl === thumbUrl);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `admin-cover-option${isCurrent ? ' is-current' : ''}`;
      btn.innerHTML = `
        <img src="${thumbUrl}" alt="${photo.name}" loading="lazy" decoding="async">
        ${isCurrent ? '<span class="admin-cover-option-badge">✓ Ảnh bìa</span>' : ''}
        <span class="admin-cover-option-name">${photo.name}</span>
      `;

      const imgEl = btn.querySelector('img');
      imgEl.onerror = () => {
        if (imgEl.src !== fallbackUrl) imgEl.src = fallbackUrl;
      };

      btn.addEventListener('click', () => {
        this.selectCoverPhoto(photo, thumbUrl, fallbackUrl);
      });

      this.coverGridEl.appendChild(btn);
    }

    if (this.coverMoreWrap) {
      this.coverMoreWrap.classList.toggle('hidden', filtered.length <= limit);
    }
  }

  selectCoverPhoto(photo, thumbUrl, fallbackUrl) {
    const idx = this.coverPickerIndex;
    const item = this.history[idx];
    if (!item) return;

    item.coverUrl = thumbUrl;
    item.coverFallbackUrl = fallbackUrl;
    item.coverPhotoId = photo.id;
    item.photoCount = this.coverPickerPhotos.length || item.photoCount || 0;
    item.updatedAt = Date.now();

    try {
      localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(this.history));
      localStorage.setItem(
        `studio_album_cover_${item.folderId}`,
        JSON.stringify({
          coverUrl: thumbUrl,
          fallbackUrl: fallbackUrl,
          photoCount: item.photoCount,
          updatedAt: Date.now(),
        })
      );
    } catch {}

    this.coverModal?.classList.add('hidden');
    this.renderHistory();
    this.syncAdminHistoryToCloud(true);
  }

  // --- XEM & COPY MÃ SỐ ẢNH KHÁCH ĐÃ CHỌN TRỰC TIẾP TRONG #ADMIN ---
  async refreshCloudSelectionCount(folderId, badgeEl) {
    if (!folderId) return;
    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
    if (!webhookUrl) return;
    try {
      const resp = await fetch(`${webhookUrl}?action=get_sync&folderId=${encodeURIComponent(folderId)}&_t=${Date.now()}`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && data.status === 'success' && data.draft && typeof data.draft === 'object') {
        const keys = Object.keys(data.draft).filter((k) => data.draft[k] && data.draft[k].selected);
        // Cập nhật cache local để số liệu trên máy tính luôn mới nhất từ điện thoại khách
        if (keys.length > 0) {
          try {
            localStorage.setItem(`studio_select_${folderId}`, JSON.stringify(data.draft));
          } catch {}
          if (badgeEl) {
            badgeEl.textContent = `♥ ${keys.length} ảnh`;
            badgeEl.classList.remove('hidden');
          }
          this.updateAdminStats();
        }
      }
    } catch {
      // ignore silent background refresh
    }
  }

  async openSelectedCodesModal(item) {
    if (!item || !item.folderId || !this.selectedModal) return;

    this.currentSelectedLRText = '';
    this.currentSelectedNumsText = '';
    this.currentSelectedDetailText = '';

    if (this.selectedModalTitle) {
      this.selectedModalTitle.textContent = `♥ Mã Ảnh Đã Chọn — ${item.client}`;
    }
    if (this.selectedModalSub) {
      this.selectedModalSub.textContent = 'Đang đồng bộ danh sách mới nhất từ Đám mây...';
    }
    this.selectedStatusEl?.classList.remove('hidden');
    if (this.selectedStatusText) {
      this.selectedStatusText.textContent = 'Đang tải danh sách ảnh khách đã chọn & tên file từ Google Drive...';
    }
    this.selectedContentEl?.classList.add('hidden');
    this.selectedModal.classList.remove('hidden');

    try {
      // 1. Lấy bản nháp chọn ảnh từ cả localStorage và Cloud (ưu tiên Cloud nếu mới hơn / có dữ liệu)
      let draft = {};
      try {
        draft = JSON.parse(localStorage.getItem(`studio_select_${item.folderId}`)) || {};
      } catch {}

      const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
      if (webhookUrl) {
        try {
          const resp = await fetch(`${webhookUrl}?action=get_sync&folderId=${encodeURIComponent(item.folderId)}&_t=${Date.now()}`);
          if (resp.ok) {
            const cloudData = await resp.json();
            if (cloudData && cloudData.status === 'success' && cloudData.draft && typeof cloudData.draft === 'object') {
              const cloudKeys = Object.keys(cloudData.draft).filter((k) => cloudData.draft[k]?.selected);
              if (cloudKeys.length > 0 || Object.keys(draft).length === 0) {
                draft = cloudData.draft;
                try {
                  localStorage.setItem(`studio_select_${item.folderId}`, JSON.stringify(draft));
                } catch {}
              }
            }
          }
        } catch {}
      }

      const selectedIds = Object.keys(draft).filter((k) => draft[k] && draft[k].selected);

      if (selectedIds.length === 0) {
        if (this.selectedStatusText) {
          this.selectedStatusText.textContent = `Khách hàng "${item.client}" hiện chưa thả tim chọn ảnh nào trong album này.`;
        }
        if (this.selectedModalSub) {
          this.selectedModalSub.textContent = 'Chưa có ảnh được chọn';
        }
        return;
      }

      // 2. Nạp danh sách ảnh từ Google Drive để dịch Photo ID -> Tên file gốc (VD: DIP_7942.JPG)
      let photoMap = new Map();
      try {
        const albumData = await loadDriveAlbum(item.folderId, STUDIO_CONFIG.googleDriveApiKey, null, false);
        for (const p of albumData?.photos || []) {
          photoMap.set(p.id, p);
        }
      } catch {}

      const rows = selectedIds.map((pid) => {
        const entry = draft[pid] || {};
        const photo = photoMap.get(pid);
        const fullName = photo?.name || pid;
        const baseName = fullName.replace(/\.[^/.]+$/, '');
        const numMatch = baseName.match(/(\d{3,6})$/);
        const shortNum = numMatch ? numMatch[1] : baseName;
        const thumbUrl = photo?.gridUrl || `https://drive.google.com/thumbnail?id=${pid}&sz=w400`;
        return {
          id: pid,
          fullName,
          baseName,
          shortNum,
          thumbUrl,
          priority: Boolean(entry.priority),
          note: (entry.note || '').trim(),
        };
      });

      rows.sort((a, b) => a.baseName.localeCompare(b.baseName, undefined, { numeric: true }));

      const priorityCount = rows.filter((r) => r.priority).length;
      const noteCount = rows.filter((r) => r.note).length;

      this.currentSelectedLRText = rows.map((r) => r.baseName).join(', ');
      this.currentSelectedNumsText = rows.map((r) => r.shortNum).join(', ');
      this.currentSelectedDetailText = [
        `📸 DANH SÁCH ẢNH KHÁCH CHỌN — ${item.client}`,
        `Tổng chọn: ${rows.length} ảnh | Ưu tiên in: ${priorityCount} | Có ghi chú: ${noteCount}`,
        `----------------------------------------`,
        ...rows.map((r, i) => {
          let line = `${i + 1}. ${r.baseName}`;
          if (r.priority) line += ' [★ ƯU TIÊN IN]';
          if (r.note) line += ` — Ghi chú: ${r.note}`;
          return line;
        }),
      ].join('\n');

      if (this.selectedModalSub) {
        this.selectedModalSub.textContent = `Đã tải xong ${rows.length} mã ảnh khách chọn (sẵn sàng copy vào Lightroom)`;
      }
      if (this.selectedSummaryEl) {
        this.selectedSummaryEl.innerHTML = `
          <span class="admin-selected-pill is-heart">♥ ${rows.length} ảnh đã chọn</span>
          ${priorityCount > 0 ? `<span class="admin-selected-pill is-star">★ ${priorityCount} ảnh ưu tiên</span>` : ''}
          ${noteCount > 0 ? `<span class="admin-selected-pill">💬 ${noteCount} ghi chú</span>` : ''}
        `;
      }
      if (this.selectedCodesText) {
        this.selectedCodesText.value = this.currentSelectedLRText;
      }
      if (this.selectedListEl) {
        this.selectedListEl.innerHTML = '';
        for (const r of rows) {
          const rowEl = document.createElement('div');
          rowEl.className = 'admin-selected-row';
          rowEl.innerHTML = `
            <img src="${r.thumbUrl}" class="admin-selected-thumb" alt="${r.baseName}" loading="lazy">
            <div class="admin-selected-info">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span class="admin-selected-name">${r.baseName}</span>
                ${r.priority ? '<span style="font-size:11px;padding:1px 6px;border-radius:6px;background:rgba(245,158,11,0.16);color:#b45309;font-weight:700;">★ Ưu tiên</span>' : ''}
              </div>
              ${r.note ? `<div class="admin-selected-note">💬 ${r.note.replace(/</g, '&lt;')}</div>` : ''}
            </div>
          `;
          this.selectedListEl.appendChild(rowEl);
        }
      }

      this.selectedStatusEl?.classList.add('hidden');
      this.selectedContentEl?.classList.remove('hidden');
    } catch (err) {
      console.error('Lỗi tải mã ảnh đã chọn:', err);
      if (this.selectedStatusText) {
        this.selectedStatusText.textContent = 'Không thể tải danh sách mã ảnh. Vui lòng thử lại!';
      }
    }
  }
}
