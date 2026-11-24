/**
 * Module điều phối chính của ứng dụng Studio Photo Selector
 */
import { STUDIO_CONFIG } from '../config.js?v=10.1';
import { loadDriveAlbum, loadDemoAlbum, stripExtension, extractDriveFolderId, clearAlbumCache } from './drive.js?v=10.1';
import { GalleryGrid } from './gallery.js?v=10.1';
import { LightboxModal } from './lightbox.js?v=10.1';
import { StorageManager } from './storage.js?v=10.1';
import { FaceFilterEngine } from './face-filter.js?v=10.1';
import { ExportService } from './export.js?v=10.1';
import { AdminManager } from './admin.js?v=10.1';

class AppController {
  constructor() {
    this.allPhotos = [];
    this.filteredPhotos = [];
    this.folders = [];
    this.activeFolderId = null;
    this.currentFilter = 'all'; // all | selected | unselected | priority | hasNote
    this.currentSort = 'name_asc'; // name_asc | name_desc | selected_first | priority_first | date_desc | date_asc
    this.searchQuery = '';

    // Trạng thái đơn hàng từ Query Params
    this.folderId = '';
    this.clientName = 'Khách hàng';
    this.packageName = 'Tiêu chuẩn';
    this.limit = 0;
    this.allowDownload = true;
    this.isDemo = false;

    // Map lựa chọn: photoId -> { selected, priority, tags: [], note: '' }
    this.selectionsMap = new Map();

    // Lọc khuôn mặt
    this.faceEngine = new FaceFilterEngine();
    this.activeFaceFilter = null; // { targetEmbedding, avatarUrl, scores: Map<id, score>, threshold }
    this.faceScoresMap = new Map();

    this.saveDraftTimer = null;
    this.cloudSyncDebounceTimer = null;
    this.isSyncing = false;
    this.lastLocalActionTime = 0;
    this.lastCloudUpdatedAt = 0;
    this.quickToggleMode = false;

    this.init();
  }

  async init() {
    try {
      this.parseQueryParams();
      this.bindDOM();
      this.initLightbox();
      this.initAdmin();
      this.initQuickDriveModal();
      this.initFaceModal();
      this.initSubmitModal();
      this.initSyncModal();
      this.initPhotoContextMenu();
      this.initSelfieCapture();

      window.addEventListener('hashchange', () => this.handleRoute());
      this.handleRoute();

      if (!this.isHomePortal) {
        await this.loadAlbumData();
      }
    } catch (err) {
      console.error('Lỗi khởi động ứng dụng:', err);
      if (this.showState) {
        this.showState('error', err.message || 'Không thể khởi động ứng dụng. Vui lòng bấm thử lại.');
      }
    }
  }

  parseQueryParams() {
    const params = new URLSearchParams(window.location.search);
    let folder = params.get('folder') || params.get('f') || '';
    let client = params.get('khach') || params.get('k') || '';
    let pkg = params.get('goi') || '';
    let limit = parseInt(params.get('limit'), 10) || 0;
    let download = params.get('download') !== '0';

    // Tra cứu link ngắn theo tên khách (?k=... hoặc ?album=...) nếu chưa có folder
    const shortKey = params.get('k') || params.get('album');
    if (shortKey && !folder) {
      try {
        const history = JSON.parse(localStorage.getItem('studio_admin_history')) || [];
        const defaultList = STUDIO_CONFIG.defaultAlbums || [];
        const allList = [...defaultList, ...history];
        const normKey = shortKey.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        const matched = allList.find((h) => {
          const s = (h.slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const c = (h.client || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          return s === normKey || c === normKey;
        });
        if (matched) {
          folder = matched.folderId;
          client = matched.client;
          pkg = matched.pkg || 'Album Tiêu Chuẩn';
          limit = matched.limit || 0;
          download = matched.download !== 0;
        }
      } catch (e) {
        // ignore
      }
    }

    // Nếu tên khách lấy từ slug k (ví dụ: doi-cuoi-tu-son-21), hiển thị đẹp mắt
    if (client && !params.get('khach') && params.get('k')) {
      client = client.replace(/[-_]+/g, ' ');
    }

    const isDemoExplicit = params.get('demo') === '1';
    this.isHomePortal = !folder && !shortKey && !isDemoExplicit;
    this.slug = shortKey || '';
    this.folderId = folder;
    this.clientName = client || (this.isHomePortal ? (STUDIO_CONFIG.studioSubtitle || 'Hệ thống chọn ảnh trực tuyến') : 'Khách hàng');
    this.packageName = pkg || 'Album Tiêu Chuẩn';
    this.limit = limit;
    this.allowDownload = download;
    this.initialSelParam = params.get('sel') || '';

    // Đọc nháp lưu từ trước nếu có
    const draft = StorageManager.loadDraft(this.folderId || 'demo');
    for (const [id, val] of Object.entries(draft)) {
      this.selectionsMap.set(id, val);
    }

    // Tự động lưu thông tin album này vào Quản lý Link của Admin
    this.registerCurrentAlbumToAdminHistory();
  }

  registerCurrentAlbumToAdminHistory() {
    if (!this.folderId) return;
    try {
      const ADMIN_STORAGE_KEY = 'studio_admin_history';
      const history = JSON.parse(localStorage.getItem(ADMIN_STORAGE_KEY)) || [];
      const baseOrigin = window.location.origin + window.location.pathname;
      const slug = (new URLSearchParams(window.location.search).get('k') || this.clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-+|-+$/g, '');
      const existing = history.find((h) => h.folderId === this.folderId || (slug && h.slug === slug));
      if (!existing) {
        history.push({
          folderId: this.folderId,
          client: this.clientName || 'doi cuoi tu son 21',
          pkg: this.packageName || 'Album Tiêu Chuẩn',
          slug: slug || 'doi-cuoi-tu-son-21',
          limit: this.limit || 0,
          download: this.allowDownload ? 1 : 0,
          shortUrl: `${baseOrigin}?k=${encodeURIComponent(slug)}&f=${encodeURIComponent(this.folderId)}`,
          link: `${baseOrigin}?k=${encodeURIComponent(slug)}&f=${encodeURIComponent(this.folderId)}`,
          updatedAt: Date.now(),
          time: 'Album hiện tại',
        });
        localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(history));
      }
    } catch {
      // ignore
    }
  }

  bindDOM() {
    this.siteHeader = document.getElementById('site-header');
    this.headerSubRow = document.querySelector('.header-sub-row');
    this.headerNavRow = document.querySelector('.header-nav-row');
    this.homePortalEl = document.getElementById('home-portal');
    this.portalSearchInput = document.getElementById('portal-search-input');
    this.portalSearchClear = document.getElementById('portal-search-clear');
    this.portalSyncBadge = document.getElementById('portal-sync-badge');
    this.portalBtnRefresh = document.getElementById('portal-btn-refresh');
    this.portalAlbumCount = document.getElementById('portal-album-count');
    this.portalAlbumsGrid = document.getElementById('portal-albums-grid');
    this.portalEmptyState = document.getElementById('portal-empty-state');
    this.portalEmptyMsg = document.getElementById('portal-empty-msg');
    this.portalBtnClearSearch = document.getElementById('portal-btn-clear-search');
    this.galleryContainer = document.getElementById('gallery-container');
    this.floatingBarWrap = document.getElementById('floating-bar-wrap');
    this.adminView = document.getElementById('admin-view');

    this.headerStudioName = document.getElementById('header-studio-name');
    this.demoBadge = document.getElementById('demo-badge');
    this.headerClientName = document.getElementById('header-client-name');
    this.headerPackageName = document.getElementById('header-package-name');
    this.headerLimitCount = document.getElementById('header-limit-count');
    this.draftIndicator = document.getElementById('draft-indicator');
    this.btnCloudSync = document.getElementById('btn-cloud-sync');
    this.syncStatusText = document.getElementById('sync-status-text');
    this.barBtnRefresh = document.getElementById('bar-btn-refresh');

    this.btnCloudSync?.addEventListener('click', () => this.syncCloudNow(true));
    this.barBtnRefresh?.addEventListener('click', () => this.refreshAlbum());

    // Tự động kiểm tra và đồng bộ từ đám mây mỗi 1.2 giây (tốc độ cao thời gian thực)
    setInterval(() => {
      if (document.visibilityState === 'visible' && this.folderId && !this.isSyncing) {
        this.pullCloudChanges(false);
      }
    }, 1200);

    // Kéo dữ liệu ngay khi người dùng chuyển tab quay lại trang web
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.folderId && !this.isSyncing) {
        this.pullCloudChanges(false);
      }
    });

    this.folderTabsEl = document.getElementById('folder-tabs');
    this.searchInput = document.getElementById('search-input');
    this.searchClearBtn = document.getElementById('search-clear-btn');

    this.galleryGridEl = document.getElementById('gallery-grid');
    this.stateLoading = document.getElementById('state-loading');
    this.stateLoadingMsg = document.getElementById('state-loading-msg');
    this.stateEmpty = document.getElementById('state-empty');
    this.stateError = document.getElementById('state-error');
    this.stateErrorMsg = document.getElementById('state-error-msg');
    this.btnRetryLoad = document.getElementById('btn-retry-load');
    this.btnResetFilters = document.getElementById('btn-reset-filters');

    // Floating bar
    this.counterPill = document.getElementById('counter-pill');
    this.counterSelected = document.getElementById('counter-selected');
    this.counterLimit = document.getElementById('counter-limit');
    this.counterWarning = document.getElementById('counter-warning');
    this.countPillAll = document.getElementById('count-pill-all');
    this.countPillSelected = document.getElementById('count-pill-selected');
    this.countPillUnselected = document.getElementById('count-pill-unselected');
    this.countPillPriority = document.getElementById('count-pill-priority');
    this.countPillNote = document.getElementById('count-pill-note');

    // Face banner & People Bar
    this.peopleBar = document.getElementById('people-bar');
    this.peopleChipsList = document.getElementById('people-chips-list');
    this.btnPeopleAll = document.getElementById('btn-people-all');
    this.peopleAllCount = document.getElementById('people-all-count');
    this.selectedClusterId = null;
    this.btnPeopleAll?.addEventListener('click', () => this.clearFaceFilter());

    this.faceActiveBanner = document.getElementById('face-active-banner');
    this.faceBannerAvatar = document.getElementById('face-banner-avatar');
    this.faceBannerCount = document.getElementById('face-banner-count');
    this.faceThresholdSlider = document.getElementById('face-threshold-slider');
    this.faceThresholdVal = document.getElementById('face-threshold-val');
    this.btnClearFaceFilter = document.getElementById('btn-clear-face-filter');

    // Header info sync
    if (this.headerStudioName) this.headerStudioName.textContent = STUDIO_CONFIG.studioName;
    if (this.headerClientName) this.headerClientName.textContent = this.clientName;
    if (this.headerPackageName) this.headerPackageName.textContent = this.packageName.replace(/_/g, ' ');
    if (this.headerLimitCount) this.headerLimitCount.textContent = this.limit > 0 ? `${this.limit} ảnh` : 'Không giới hạn';
    if (this.counterLimit) this.counterLimit.textContent = this.limit > 0 ? `${this.limit}` : '∞';

    // Thông tin định mức ảnh (chỉ hiển thị số lượng ảnh ngoài giao diện, không cho sửa)
    this.headerLimitPill = document.getElementById('header-limit-pill');
    this.adminNavBtn = document.getElementById('btn-to-admin');
    this.adminNavIcon = document.getElementById('admin-nav-icon');
    this.adminNavText = document.getElementById('admin-nav-text');

    // Tiện ích: Chạm 3 lần nhanh vào Logo DIP trên Header để mở nhanh Quản Trị (#admin)
    const brandMark = document.querySelector('.brand-mark');
    let brandTapCount = 0;
    let brandTapTimer = null;
    brandMark?.addEventListener('click', () => {
      brandTapCount++;
      clearTimeout(brandTapTimer);
      brandTapTimer = setTimeout(() => { brandTapCount = 0; }, 600);
      if (brandTapCount >= 3) {
        brandTapCount = 0;
        window.location.hash = '#admin';
        this.showToast('⚙️ Mở bảng Quản trị Studio');
      }
    });

    // Search & Sort inputs
    this.sortSelect = document.getElementById('sort-select');
    this.sortSelect?.addEventListener('change', () => {
      this.currentSort = this.sortSelect.value;
      this.applyFilters();
    });

    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value.trim().toLowerCase();
      this.searchClearBtn.classList.toggle('hidden', !this.searchQuery);
      this.applyFilters();
    });
    this.searchClearBtn.addEventListener('click', () => {
      this.searchInput.value = '';
      this.searchQuery = '';
      this.searchClearBtn.classList.add('hidden');
      this.applyFilters();
    });

    // Reset filters
    this.btnResetFilters.addEventListener('click', () => {
      this.currentFilter = 'all';
      this.searchQuery = '';
      this.searchInput.value = '';
      this.clearFaceFilter();
      this.updateActiveFilterPill();
      this.applyFilters();
    });

    this.btnRetryLoad.addEventListener('click', () => this.loadAlbumData());

    // Filter pills
    const pills = document.querySelectorAll('.filter-pill');
    pills.forEach((p) => {
      p.addEventListener('click', () => {
        this.currentFilter = p.dataset.filter;
        this.updateActiveFilterPill();
        this.applyFilters();
      });
    });

    // Face threshold
    this.faceThresholdSlider.addEventListener('input', () => {
      const val = parseFloat(this.faceThresholdSlider.value);
      this.faceThresholdVal.textContent = `${Math.round(val * 100)}%`;
      if (this.activeFaceFilter) {
        this.activeFaceFilter.threshold = val;
        this.applyFilters();
      }
    });

    this.btnClearFaceFilter.addEventListener('click', () => this.clearFaceFilter());

    // Khởi tạo GalleryGrid
    this.galleryGrid = new GalleryGrid(this.galleryGridEl, {
      allowDownload: this.allowDownload,
      getSelection: (id) => this.getPhotoSelection(id),
      getFaceScore: (id) => this.faceScoresMap.get(id),
      getCurrentFilter: () => this.currentFilter,
      onToggleHeart: (id) => this.toggleHeart(id),
      onToggleStar: (id) => this.toggleStar(id),
      onOpenLightbox: (index, focusNote) => this.openLightboxAt(index, focusNote),
      onDownloadPhoto: (photo) => this.downloadSinglePhoto(photo),
      onPhotoLongPress: (photo, index) => this.openPhotoContextMenu(photo, index),
    });
  }

  handleRoute() {
    const isAdmin = window.location.hash === '#admin';
    if (isAdmin) {
      this.siteHeader.classList.add('hidden');
      this.homePortalEl?.classList.add('hidden');
      this.galleryContainer.classList.add('hidden');
      this.floatingBarWrap.classList.add('hidden');
      this.faceActiveBanner.classList.add('hidden');
      if (this.peopleBar) this.peopleBar.classList.add('hidden');
      this.adminView.classList.remove('hidden');
      this.adminManager?.checkAuthState();
    } else if (this.isHomePortal) {
      this.siteHeader.classList.remove('hidden');
      this.headerSubRow?.classList.add('hidden');
      this.headerNavRow?.classList.add('hidden');
      this.homePortalEl?.classList.remove('hidden');
      this.galleryContainer.classList.add('hidden');
      this.floatingBarWrap.classList.add('hidden');
      this.faceActiveBanner.classList.add('hidden');
      if (this.peopleBar) this.peopleBar.classList.add('hidden');
      this.adminView.classList.add('hidden');
      this.updateAdminHeaderState();
      this.initHomePortal();
    } else {
      this.siteHeader.classList.remove('hidden');
      this.headerSubRow?.classList.remove('hidden');
      this.headerNavRow?.classList.remove('hidden');
      this.homePortalEl?.classList.add('hidden');
      this.galleryContainer.classList.remove('hidden');
      this.floatingBarWrap.classList.remove('hidden');
      this.adminView.classList.add('hidden');
      if (this.faceClusters?.length && this.peopleBar) {
        this.peopleBar.classList.remove('hidden');
      }
      if (this.activeFaceFilter) {
        this.faceActiveBanner.classList.remove('hidden');
      }
      this.updateAdminHeaderState();
    }
  }

  // --- TRANG CHỦ TRA CỨU & DANH SÁCH TẤT CẢ ALBUM (HOME PORTAL) ---
  normalizeSearchText(str) {
    return (str || '')
      .toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .replace(/[-_/.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  initHomePortal() {
    if (!this.portalInitialized) {
      this.portalInitialized = true;
      this.portalAlbums = [];
      this.portalQuery = '';

      this.portalSearchInput?.addEventListener('input', () => {
        this.portalQuery = this.portalSearchInput.value.trim();
        this.portalSearchClear?.classList.toggle('hidden', !this.portalQuery);
        this.renderPortalAlbums();
      });

      this.portalSearchInput?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const val = this.portalSearchInput.value.trim();
        if (!val) return;

        // Nếu dán link hoặc ID Google Drive trực tiếp -> mở luôn album
        const driveId = extractDriveFolderId(val);
        if (driveId && val.length >= 20) {
          const baseOrigin = window.location.origin + window.location.pathname;
          window.location.href = `${baseOrigin}?folder=${encodeURIComponent(driveId)}`;
          return;
        }

        // Nếu kết quả lọc còn đúng 1 album -> mở luôn khi bấm Enter
        const filtered = this.getFilteredPortalAlbums();
        if (filtered.length === 1) {
          window.location.href = this.buildPortalAlbumUrl(filtered[0]);
        }
      });

      const resetSearch = () => {
        if (this.portalSearchInput) {
          this.portalSearchInput.value = '';
          this.portalSearchInput.focus();
        }
        this.portalQuery = '';
        this.portalSearchClear?.classList.add('hidden');
        this.renderPortalAlbums();
      };

      this.portalSearchClear?.addEventListener('click', resetSearch);
      this.portalBtnClearSearch?.addEventListener('click', resetSearch);
      this.portalBtnRefresh?.addEventListener('click', () => this.loadPortalAlbums(true));
    }

    this.loadPortalAlbums(false);
  }

  buildPortalAlbumUrl(item) {
    const baseOrigin = window.location.origin + window.location.pathname;
    if (item.slug && item.folderId) {
      let url = `${baseOrigin}?k=${encodeURIComponent(item.slug)}&f=${encodeURIComponent(item.folderId)}`;
      if (item.limit > 0) url += `&limit=${item.limit}`;
      return url;
    }
    if (item.folderId) {
      return `${baseOrigin}?folder=${encodeURIComponent(item.folderId)}&khach=${encodeURIComponent(item.client || '')}`;
    }
    return item.shortUrl || item.link || baseOrigin;
  }

  mergePortalAlbumLists(lists, deletedMap = {}) {
    const map = new Map();
    const isDeleted = (item) => {
      if (!item) return true;
      const itemTs = item.updatedAt || 0;
      const keys = [item.folderId, item.slug].filter(Boolean).map((k) => k.toString().toLowerCase().trim());
      return keys.some((k) => deletedMap[k] && deletedMap[k] >= itemTs);
    };

    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || item.__deleted || (!item.folderId && !item.slug)) continue;
        if (isDeleted(item)) continue;
        const key = (item.folderId || item.slug).toString().trim();
        if (!map.has(key)) {
          map.set(key, item);
        } else {
          const prev = map.get(key);
          if ((item.updatedAt || 0) >= (prev.updatedAt || 0)) {
            map.set(key, { ...prev, ...item });
          }
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async loadPortalAlbums(forceToast = false) {
    // 1. Nạp tức thì từ config.js + localStorage (có tôn trọng danh sách đã xóa)
    let deletedMap = {};
    try {
      const rawDel = JSON.parse(localStorage.getItem('studio_admin_deleted_albums'));
      if (rawDel && typeof rawDel === 'object') deletedMap = rawDel;
    } catch {}

    let localList = [];
    try {
      localList = JSON.parse(localStorage.getItem('studio_admin_history')) || [];
    } catch {
      localList = [];
    }
    const defaultList = (STUDIO_CONFIG.defaultAlbums || []).map((a) => ({ ...a, updatedAt: 1 }));
    this.portalAlbums = this.mergePortalAlbumLists([defaultList, localList], deletedMap);
    this.renderPortalAlbums();

    // 2. Kéo danh sách đầy đủ mới nhất từ Đám mây (Google Apps Script)
    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
    if (!webhookUrl) {
      if (this.portalSyncBadge) this.portalSyncBadge.textContent = `Hiển thị ${this.portalAlbums.length} album có sẵn`;
      return;
    }

    if (this.portalSyncBadge) this.portalSyncBadge.textContent = '☁️ Đang cập nhật danh sách album mới nhất...';
    if (this.portalBtnRefresh) this.portalBtnRefresh.disabled = true;

    try {
      const resp = await fetch(`${webhookUrl}?action=get_admin_history&_t=${Date.now()}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data && data.status === 'success' && Array.isArray(data.history)) {
        const cloudActive = [];
        let deletedUpdated = false;
        for (const entry of data.history) {
          if (!entry) continue;
          if (entry.__deleted) {
            const k = (entry.key || entry.folderId || entry.slug || '').toString().toLowerCase().trim();
            const ts = entry.updatedAt || Date.now();
            if (k && (!deletedMap[k] || ts > deletedMap[k])) {
              deletedMap[k] = ts;
              deletedUpdated = true;
            }
          } else {
            cloudActive.push(entry);
          }
        }
        if (deletedUpdated) {
          try {
            localStorage.setItem('studio_admin_deleted_albums', JSON.stringify(deletedMap));
          } catch {}
        }

        this.portalAlbums = this.mergePortalAlbumLists([defaultList, localList, cloudActive], deletedMap);
        try {
          localStorage.setItem('studio_admin_history', JSON.stringify(this.portalAlbums.slice(0, 50)));
        } catch {}
        this.renderPortalAlbums();
        if (this.portalSyncBadge) {
          this.portalSyncBadge.textContent = `🟢 Đã đồng bộ ${this.portalAlbums.length} album từ Đám mây`;
        }
      } else if (this.portalSyncBadge) {
        this.portalSyncBadge.textContent = `🟢 Sẵn sàng (${this.portalAlbums.length} album)`;
      }
    } catch (err) {
      console.warn('Không thể tải danh sách album đám mây cho trang chủ:', err);
      if (this.portalSyncBadge) {
        this.portalSyncBadge.textContent = `🟢 Đang hiển thị ${this.portalAlbums.length} album`;
      }
    } finally {
      if (this.portalBtnRefresh) this.portalBtnRefresh.disabled = false;
      if (forceToast && this.showToast) {
        this.showToast('Đã làm mới danh sách album!', 'success');
      }
    }
  }

  getFilteredPortalAlbums() {
    const q = this.normalizeSearchText(this.portalQuery);
    if (!q) return this.portalAlbums;
    const tokens = q.split(' ').filter(Boolean);
    return this.portalAlbums.filter((item) => {
      const haystack = this.normalizeSearchText(
        [item.client, item.slug, item.time, item.pkg, item.folderId].filter(Boolean).join(' ')
      );
      return tokens.every((tk) => haystack.includes(tk));
    });
  }

  renderPortalAlbums() {
    if (!this.portalAlbumsGrid) return;
    const filtered = this.getFilteredPortalAlbums();

    if (this.portalAlbumCount) {
      this.portalAlbumCount.textContent = filtered.length;
    }

    this.portalAlbumsGrid.innerHTML = '';

    if (filtered.length === 0) {
      this.portalEmptyState?.classList.remove('hidden');
      if (this.portalEmptyMsg) {
        this.portalEmptyMsg.textContent = this.portalQuery
          ? `Không tìm thấy album nào khớp với "${this.portalQuery}". Hãy thử gõ không dấu hoặc nhập ngày chụp khác nhé!`
          : 'Chưa có album nào được tạo. Studio hãy vào mục Quản trị để tạo link album đầu tiên.';
      }
      return;
    }

    this.portalEmptyState?.classList.add('hidden');
    if (!this.portalCoverFetching) {
      this.portalCoverFetching = new Set();
    }

    for (const item of filtered) {
      const a = document.createElement('a');
      a.className = 'portal-album-card';
      a.href = this.buildPortalAlbumUrl(item);

      const safeClient = (item.client || item.slug || 'Album ảnh').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const safePkg = (item.pkg || 'Album Tiêu Chuẩn').replace(/_/g, ' ').replace(/</g, '&lt;');
      const safeTime = (item.time || 'Album mới').replace(/</g, '&lt;');
      const safeSlug = item.slug ? `?k=${item.slug.replace(/</g, '&lt;')}` : '';

      const cachedMeta = this.getCachedAlbumCover(item);
      const initialCover = cachedMeta.coverUrl || '';
      const initialFallback = cachedMeta.fallbackUrl || '';
      const initialCount = cachedMeta.photoCount || 0;

      a.innerHTML = `
        <div class="portal-card-cover-wrap${initialCover ? '' : ' is-loading'}">
          <span class="portal-card-cover-placeholder" aria-hidden="true">📸</span>
          <img class="portal-card-cover-img" alt="${safeClient}" loading="lazy" decoding="async">
          <span class="portal-card-date">📅 ${safeTime}</span>
          <span class="portal-card-count-badge${initialCount > 0 ? '' : ' hidden'}">🖼️ ${initialCount} ảnh</span>
        </div>
        <div class="portal-card-body">
          <div>
            <h4 class="portal-card-title">${safeClient}</h4>
            <div class="portal-card-meta">
              <span class="portal-card-pkg">${safePkg}</span>
              ${safeSlug ? `<span class="portal-card-slug">${safeSlug}</span>` : ''}
            </div>
          </div>
          <div class="portal-card-footer">
            <span>Xem &amp; chọn ảnh</span>
            <span class="portal-card-arrow">→</span>
          </div>
        </div>
      `;

      const coverWrap = a.querySelector('.portal-card-cover-wrap');
      const coverImg = a.querySelector('.portal-card-cover-img');
      const countBadge = a.querySelector('.portal-card-count-badge');

      const applyCoverImage = (url, fallbackUrl) => {
        if (!url || !coverImg) return;
        coverImg.onload = () => {
          coverImg.classList.add('is-loaded');
          coverWrap?.classList.remove('is-loading');
          coverWrap?.classList.add('has-photo');
        };
        coverImg.onerror = () => {
          if (fallbackUrl && coverImg.src !== fallbackUrl) {
            coverImg.src = fallbackUrl;
          } else {
            coverWrap?.classList.remove('is-loading');
          }
        };
        coverImg.src = url;
      };

      if (initialCover) {
        applyCoverImage(initialCover, initialFallback);
      } else if (item.folderId) {
        this.fetchPortalAlbumCover(item, applyCoverImage, coverWrap, countBadge);
      } else {
        coverWrap?.classList.remove('is-loading');
      }

      this.portalAlbumsGrid.appendChild(a);
    }
  }

  getCachedAlbumCover(item) {
    if (!item) return {};
    let coverUrl = item.coverUrl || '';
    let fallbackUrl = item.coverFallbackUrl || '';
    let photoCount = item.photoCount || 0;

    if (item.folderId) {
      try {
        const raw = localStorage.getItem(`studio_album_cover_${item.folderId}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (!coverUrl && parsed.coverUrl) coverUrl = parsed.coverUrl;
          if (!fallbackUrl && parsed.fallbackUrl) fallbackUrl = parsed.fallbackUrl;
          if (!photoCount && parsed.photoCount) photoCount = parsed.photoCount;
        }
      } catch {}
    }
    return { coverUrl, fallbackUrl, photoCount };
  }

  saveCachedAlbumCover(folderId, firstPhoto, photoCount) {
    if (!folderId || !firstPhoto) return null;
    const coverUrl = firstPhoto.gridUrl || firstPhoto.thumbnailLink || (firstPhoto.id ? `https://drive.google.com/thumbnail?id=${firstPhoto.id}&sz=w800` : '');
    const fallbackUrl = firstPhoto.id ? `https://lh3.googleusercontent.com/d/${firstPhoto.id}=w800` : '';
    if (!coverUrl) return null;

    const payload = { coverUrl, fallbackUrl, photoCount: photoCount || 0, updatedAt: Date.now() };
    try {
      localStorage.setItem(`studio_album_cover_${folderId}`, JSON.stringify(payload));
    } catch {}
    return payload;
  }

  async fetchPortalAlbumCover(item, applyCoverImage, coverWrap, countBadge) {
    const folderId = item.folderId;
    if (!folderId) return;
    if (this.portalCoverFetching.has(folderId)) return;
    this.portalCoverFetching.add(folderId);

    try {
      const data = await loadDriveAlbum(folderId, STUDIO_CONFIG.googleDriveApiKey, null, false);
      const photos = data?.photos || [];
      if (photos.length > 0) {
        const saved = this.saveCachedAlbumCover(folderId, photos[0], photos.length);
        if (saved) {
          item.coverUrl = saved.coverUrl;
          item.coverFallbackUrl = saved.fallbackUrl;
          item.photoCount = saved.photoCount;
          applyCoverImage(saved.coverUrl, saved.fallbackUrl);
          if (countBadge) {
            countBadge.textContent = `🖼️ ${photos.length} ảnh`;
            countBadge.classList.remove('hidden');
          }
          return;
        }
      }
      coverWrap?.classList.remove('is-loading');
    } catch (err) {
      console.warn(`Không tải được ảnh đại diện cho album ${item.client || folderId}:`, err);
      coverWrap?.classList.remove('is-loading');
    } finally {
      this.portalCoverFetching.delete(folderId);
    }
  }

  updateAdminHeaderState() {
    const isAuth = Boolean(this.adminManager?.isLoggedIn());
    if (this.adminNavText) {
      this.adminNavText.textContent = isAuth ? 'Quản trị' : 'Đăng nhập';
    }
    if (this.adminNavIcon) {
      this.adminNavIcon.textContent = isAuth ? '⚙️' : '👤';
    }
    if (this.adminNavBtn) {
      this.adminNavBtn.classList.toggle('is-logged-in', isAuth);
      this.adminNavBtn.title = isAuth ? 'Đang đăng nhập quyền Quản trị Studio' : 'Đăng nhập tài khoản Quản trị Studio';
    }
    if (this.headerLimitEditIcon) {
      this.headerLimitEditIcon.classList.toggle('hidden', !isAuth);
    }
    if (this.headerLimitPill) {
      this.headerLimitPill.title = isAuth
        ? 'Bấm để chỉnh sửa định mức số lượng ảnh chọn'
        : 'Định mức số lượng ảnh chọn của gói (Chỉ Admin mới có quyền sửa)';
    }
  }

  updateHeaderAlbumInfo() {
    if (this.headerClientName) this.headerClientName.textContent = this.clientName;
    if (this.headerPackageName) this.headerPackageName.textContent = this.packageName;
    if (this.headerLimitCount) {
      this.headerLimitCount.textContent = this.limit > 0 ? `Định mức: ${this.limit} ảnh` : 'Định mức: Không giới hạn';
    }
  }

  async loadAlbumData(forceRefresh = false) {
    this.showState('loading', forceRefresh ? 'Đang tải lại danh sách ảnh mới nhất từ Google Drive...' : 'Đang kết nối thư mục Google Drive...');
    try {
      if (!this.folderId) {
        const params = new URLSearchParams(window.location.search);
        const shortKey = params.get('k') || params.get('album');
        if (shortKey) {
          const normKey = shortKey.toLowerCase().trim();

          // 1. Kiểm tra nhanh trong defaultAlbums cấu hình sẵn
          const defAlbum = (STUDIO_CONFIG.defaultAlbums || []).find(
            (a) => a.slug && a.slug.toLowerCase().trim() === normKey
          );
          if (defAlbum && defAlbum.folderId) {
            this.folderId = defAlbum.folderId;
            this.clientName = defAlbum.client || shortKey;
            this.packageName = defAlbum.pkg || 'Album Tiêu Chuẩn';
            this.limit = defAlbum.limit || 0;
            this.allowDownload = defAlbum.download !== 0;
            this.updateHeaderAlbumInfo();
          }

          // 2. Kiểm tra trong bộ nhớ admin cục bộ nếu có
          if (!this.folderId) {
            try {
              const localHistory = JSON.parse(localStorage.getItem('studio_admin_history')) || [];
              const matched = localHistory.find((h) => h.slug && h.slug.toLowerCase().trim() === normKey);
              if (matched && matched.folderId) {
                this.folderId = matched.folderId;
                this.clientName = matched.client || shortKey;
                this.packageName = matched.pkg || 'Album Tiêu Chuẩn';
                this.limit = matched.limit || 0;
                this.allowDownload = matched.download !== 0;
                this.updateHeaderAlbumInfo();
              }
            } catch (e) {}
          }

          // 3. Nếu chưa thấy, tra cứu đám mây qua Apps Script Webhook
          if (!this.folderId) {
            const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
            if (webhookUrl) {
              try {
                this.stateLoadingMsg.textContent = `Đang tìm album "${shortKey}"...`;
                const res = await fetch(`${webhookUrl}?action=get_album&slug=${encodeURIComponent(normKey)}`);
                if (res.ok) {
                  const json = await res.json();
                  if (json && json.status === 'success' && json.album && json.album.folderId) {
                    this.folderId = json.album.folderId;
                    this.clientName = json.album.client || shortKey;
                    this.packageName = json.album.pkg || 'Album Tiêu Chuẩn';
                    this.limit = json.album.limit || 0;
                    this.allowDownload = json.album.download !== 0;
                    this.updateHeaderAlbumInfo();
                    this.registerCurrentAlbumToAdminHistory();
                  }
                }

                // Dự phòng: nếu get_album chưa tìm thấy, thử tra cứu get_admin_history
                if (!this.folderId) {
                  const resHist = await fetch(`${webhookUrl}?action=get_admin_history`);
                  if (resHist.ok) {
                    const jsonHist = await resHist.json();
                    if (jsonHist && jsonHist.status === 'success' && Array.isArray(jsonHist.history)) {
                      const found = jsonHist.history.find((h) => h.slug && h.slug.toLowerCase().trim() === normKey);
                      if (found && found.folderId) {
                        this.folderId = found.folderId;
                        this.clientName = found.client || shortKey;
                        this.packageName = found.pkg || 'Album Tiêu Chuẩn';
                        this.limit = found.limit || 0;
                        this.allowDownload = found.download !== 0;
                        this.updateHeaderAlbumInfo();
                        this.registerCurrentAlbumToAdminHistory();
                      }
                    }
                  }
                }
              } catch (e) {
                console.warn('Lỗi tra cứu album từ webhook:', e);
              }
            }
          }
        }
      }

      let data;
      if (this.folderId) {
        data = await loadDriveAlbum(
          this.folderId,
          STUDIO_CONFIG.googleDriveApiKey,
          (msg) => {
            this.stateLoadingMsg.textContent = msg;
          },
          forceRefresh
        );
      } else {
        // Không truyền folder -> dùng Demo Album tích hợp
        this.isDemo = true;
        this.demoBadge.classList.remove('hidden');
        data = await loadDemoAlbum();
      }

      this.allPhotos = data.photos || [];
      this.folders = data.folders || [];

      if (this.folderId && this.allPhotos.length > 0) {
        this.saveCachedAlbumCover(this.folderId, this.allPhotos[0], this.allPhotos.length);
      }

      if (this.allPhotos.length === 0) {
        this.showState('empty', 'Thư mục Google Drive này chưa có file ảnh nào.');
        return;
      }

      this.renderFolderTabs();
      await this.loadCachedClusters();

      if (this.initialSelParam) {
        this.applySelectedFromParam(this.initialSelParam);
      }

      this.showState('gallery');
      this.applyFilters();
      this.updateCounters();

      if (data.isFromCache) {
        this.showToast('⚡ Đã mở album tức thì từ bộ nhớ đệm');
      }

      // Kéo dữ liệu nháp mới nhất từ các thiết bị khác (chạy nền)
      await this.pullCloudChanges(false);
    } catch (err) {
      console.error('Lỗi nạp album:', err);
      let msg = err.message || 'Không thể truy cập Google Drive.';
      if (err.code === 'MISSING_API_KEY') {
        msg = `${msg} Bạn có thể xem Album Demo mẫu hoặc nhập API Key vào file config.js.`;
      }
      this.showState('error', msg);
    }
  }

  showState(state, message = '') {
    this.galleryGridEl.classList.toggle('hidden', state !== 'gallery');
    this.stateLoading.classList.toggle('hidden', state !== 'loading');
    this.stateEmpty.classList.toggle('hidden', state !== 'empty');
    this.stateError.classList.toggle('hidden', state !== 'error');

    if (state === 'loading') this.stateLoadingMsg.textContent = message;
    if (state === 'empty') document.getElementById('state-empty-msg').textContent = message;
    if (state === 'error') this.stateErrorMsg.textContent = message;
  }

  renderFolderTabs() {
    this.folderTabsEl.innerHTML = '';
    if (this.folders.length <= 1) {
      this.folderTabsEl.classList.add('hidden');
      return;
    }
    this.folderTabsEl.classList.remove('hidden');

    // Tab "Tất cả"
    const allTab = document.createElement('button');
    allTab.type = 'button';
    allTab.className = `folder-tab${!this.activeFolderId ? ' is-active' : ''}`;
    allTab.innerHTML = `<span>Tất cả phân cảnh</span><span class="folder-tab-count">${this.allPhotos.length}</span>`;
    allTab.addEventListener('click', () => {
      this.activeFolderId = null;
      this.updateActiveFolderTab();
      this.applyFilters();
    });
    this.folderTabsEl.appendChild(allTab);

    // Từng folder con
    for (const f of this.folders) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = `folder-tab${this.activeFolderId === f.id ? ' is-active' : ''}`;
      tab.dataset.folderId = f.id;
      tab.innerHTML = `<span>${f.name}</span><span class="folder-tab-count">${f.count}</span>`;
      tab.addEventListener('click', () => {
        this.activeFolderId = f.id;
        this.updateActiveFolderTab();
        this.applyFilters();
      });
      this.folderTabsEl.appendChild(tab);
    }
  }

  updateActiveFolderTab() {
    const tabs = this.folderTabsEl.querySelectorAll('.folder-tab');
    tabs.forEach((t) => {
      if (!this.activeFolderId) {
        t.classList.toggle('is-active', !t.dataset.folderId);
      } else {
        t.classList.toggle('is-active', t.dataset.folderId === this.activeFolderId);
      }
    });
  }

  updateActiveFilterPill() {
    const pills = document.querySelectorAll('.filter-pill');
    pills.forEach((p) => {
      p.classList.toggle('is-active', p.dataset.filter === this.currentFilter);
    });
  }

  applyFilters() {
    let list = this.allPhotos;

    // 1. Phân cảnh thư mục
    if (this.activeFolderId) {
      list = list.filter((p) => p.folderId === this.activeFolderId);
    }

    // 2. Tìm kiếm tên file
    if (this.searchQuery) {
      list = list.filter((p) => p.name.toLowerCase().includes(this.searchQuery));
    }

    // 3. Lọc theo khuôn mặt
    if (this.activeFaceFilter) {
      const th = this.activeFaceFilter.threshold;
      list = list.filter((p) => {
        const score = this.activeFaceFilter.scores.get(p.id) || 0;
        return score >= th;
      });
      this.faceBannerCount.textContent = `Tìm thấy ${list.length} bức ảnh khớp khuôn mặt`;
    }

    // 4. Lọc trạng thái (Tất cả, Đã chọn, Chưa chọn, Ưu tiên, Có ghi chú)
    if (this.currentFilter === 'selected') {
      list = list.filter((p) => this.getPhotoSelection(p.id).selected);
    } else if (this.currentFilter === 'unselected') {
      list = list.filter((p) => !this.getPhotoSelection(p.id).selected);
    } else if (this.currentFilter === 'priority') {
      list = list.filter((p) => this.getPhotoSelection(p.id).priority);
    } else if (this.currentFilter === 'hasNote') {
      list = list.filter((p) => {
        const s = this.getPhotoSelection(p.id);
        return (s.tags && s.tags.length > 0) || Boolean(s.note && s.note.trim());
      });
    }

    // 5. Sắp xếp danh sách ảnh
    const naturalCollator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
    list = [...list].sort((a, b) => {
      if (this.currentSort === 'name_asc') {
        return naturalCollator.compare(a.name, b.name);
      }
      if (this.currentSort === 'name_desc') {
        return naturalCollator.compare(b.name, a.name);
      }
      if (this.currentSort === 'selected_first') {
        const aSel = this.getPhotoSelection(a.id).selected ? 1 : 0;
        const bSel = this.getPhotoSelection(b.id).selected ? 1 : 0;
        if (bSel !== aSel) return bSel - aSel;
        return naturalCollator.compare(a.name, b.name);
      }
      if (this.currentSort === 'priority_first') {
        const aPri = this.getPhotoSelection(a.id).priority ? 1 : 0;
        const bPri = this.getPhotoSelection(b.id).priority ? 1 : 0;
        if (bPri !== aPri) return bPri - aPri;
        return naturalCollator.compare(a.name, b.name);
      }
      if (this.currentSort === 'date_desc') {
        return (b.size || 0) - (a.size || 0) || naturalCollator.compare(b.name, a.name);
      }
      if (this.currentSort === 'date_asc') {
        return (a.size || 0) - (b.size || 0) || naturalCollator.compare(a.name, b.name);
      }
      return 0;
    });

    this.filteredPhotos = list;

    if (list.length === 0 && this.allPhotos.length > 0) {
      this.showState('empty', 'Không có bức ảnh nào khớp với bộ lọc hiện tại.');
    } else {
      this.showState('gallery');
      this.galleryGrid.setPhotos(list);
    }

    this.updateCounters();
    this.updateSelectedToolbar();
  }

  getPhotoSelection(photoId) {
    return this.selectionsMap.get(photoId) || { selected: false, priority: false, tags: [], note: '' };
  }

  toggleHeart(photoId) {
    this.lastLocalActionTime = Date.now();
    const cur = this.getPhotoSelection(photoId);
    const nextSelected = !cur.selected;
    // Nếu bỏ chọn thì tự động hủy luôn ưu tiên để logic chặt chẽ
    const nextPriority = nextSelected ? cur.priority : false;

    this.selectionsMap.set(photoId, {
      ...cur,
      selected: nextSelected,
      priority: nextPriority,
      updatedAt: Date.now(),
    });

    this.galleryGrid.updateCardState(photoId, this.getPhotoSelection(photoId));
    this.updateCounters();
    this.updateSelectedToolbar();
    this.scheduleSaveDraft();

    if (nextSelected && this.limit > 0) {
      let selCount = 0;
      for (const [id, s] of this.selectionsMap.entries()) {
        if (s.selected) selCount++;
      }
      if (selCount > this.limit) {
        const extra = selCount - this.limit;
        const fee = extra * 25000;
        this.showToast(`⚠️ Bạn đã chọn vượt định mức gói (+${extra} ảnh). Phí sửa thêm là 25.000 VNĐ / ảnh (+${fee.toLocaleString('vi-VN')} đ).`);
      }
    }
  }

  toggleStar(photoId) {
    this.lastLocalActionTime = Date.now();
    const cur = this.getPhotoSelection(photoId);
    const nextPriority = !cur.priority;
    // Nếu đánh dấu ưu tiên thì tự động kích hoạt chọn
    const nextSelected = nextPriority ? true : cur.selected;

    this.selectionsMap.set(photoId, {
      ...cur,
      selected: nextSelected,
      priority: nextPriority,
      updatedAt: Date.now(),
    });

    this.galleryGrid.updateCardState(photoId, this.getPhotoSelection(photoId));
    this.updateCounters();
    this.updateSelectedToolbar();
    this.scheduleSaveDraft();

    if (nextSelected && this.limit > 0) {
      let selCount = 0;
      for (const [id, s] of this.selectionsMap.entries()) {
        if (s.selected) selCount++;
      }
      if (selCount > this.limit) {
        const extra = selCount - this.limit;
        const fee = extra * 25000;
        this.showToast(`⚠️ Bạn đã chọn vượt định mức gói (+${extra} ảnh). Phí sửa thêm là 25.000 VNĐ / ảnh (+${fee.toLocaleString('vi-VN')} đ).`);
      }
    }
  }

  toggleTag(photoId, tag) {
    this.lastLocalActionTime = Date.now();
    const cur = this.getPhotoSelection(photoId);
    const set = new Set(cur.tags || []);
    if (set.has(tag)) {
      set.delete(tag);
    } else {
      set.add(tag);
      cur.selected = true;
    }
    cur.tags = Array.from(set);
    cur.updatedAt = Date.now();

    this.selectionsMap.set(photoId, { ...cur });
    this.galleryGrid.updateCardState(photoId, this.getPhotoSelection(photoId));
    this.updateCounters();
    this.updateSelectedToolbar();
    this.scheduleSaveDraft();
  }

  updateNote(photoId, noteText) {
    this.lastLocalActionTime = Date.now();
    const cur = this.getPhotoSelection(photoId);
    cur.note = noteText;
    if (noteText.trim()) {
      cur.selected = true;
    }
    cur.updatedAt = Date.now();
    this.selectionsMap.set(photoId, { ...cur });
    this.galleryGrid.updateCardState(photoId, this.getPhotoSelection(photoId));
    this.updateCounters();
    this.updateSelectedToolbar();
    this.scheduleSaveDraft();
  }

  scheduleSaveDraft() {
    this.draftIndicator.textContent = 'Đang lưu nháp...';
    this.draftIndicator.classList.remove('is-saved');

    if (this.saveDraftTimer) clearTimeout(this.saveDraftTimer);
    this.saveDraftTimer = setTimeout(() => {
      StorageManager.saveDraft(this.folderId || 'demo', this.selectionsMap);
      this.draftIndicator.textContent = 'Đã lưu tự động';
      this.draftIndicator.classList.add('is-saved');
    }, 300);

    // Tự động đẩy lên đám mây (Cloud Sync) sau 350ms (Đồng bộ tốc độ cao 1 giây)
    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
    if (webhookUrl && this.folderId) {
      if (this.cloudSyncDebounceTimer) clearTimeout(this.cloudSyncDebounceTimer);
      this.setCloudSyncStatus('syncing', 'Đang lưu đám mây...');
      this.cloudSyncDebounceTimer = setTimeout(async () => {
        const ok = await StorageManager.saveCloudDraft(webhookUrl, this.folderId, this.clientName, this.selectionsMap);
        this.setCloudSyncStatus(ok ? 'synced' : 'error', ok ? 'Đã đồng bộ' : 'Lỗi đồng bộ');
        if (ok) this.lastCloudUpdatedAt = Date.now();
      }, 350);
    }
  }

  // --- Phân hệ Đồng Bộ Đa Thiết Bị Đám Mây (Cloud Sync) ---
  setCloudSyncStatus(status, text) {
    if (!this.btnCloudSync) return;
    this.btnCloudSync.classList.remove('is-syncing', 'is-error');
    if (status === 'syncing') {
      this.btnCloudSync.classList.add('is-syncing');
      if (this.syncStatusText) this.syncStatusText.textContent = text || 'Đang đồng bộ...';
    } else if (status === 'error') {
      this.btnCloudSync.classList.add('is-error');
      if (this.syncStatusText) this.syncStatusText.textContent = text || 'Lỗi đồng bộ';
    } else {
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      if (this.syncStatusText) this.syncStatusText.textContent = `Đã đồng bộ ${timeStr}`;
      this.btnCloudSync.title = `Đã đồng bộ đám mây lúc ${timeStr}. Bấm để đồng bộ ngay.`;
    }
  }

  async pullCloudChanges(showToastMsg = false) {
    if (this.isSyncing) return;
    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
    if (!webhookUrl || !this.folderId) return;

    this.isSyncing = true;
    try {
      const cloudResult = await StorageManager.fetchCloudDraft(webhookUrl, this.folderId);
      if (!cloudResult || !cloudResult.draft) return;

      const cloudDraft = cloudResult.draft;
      const cloudTime = cloudResult.updatedAt || 0;

      // Chỉ cập nhật nếu đám mây có thời gian mới hơn thao tác cục bộ gần nhất (hoặc là lần đầu nạp)
      if (cloudTime > this.lastLocalActionTime || this.lastCloudUpdatedAt === 0) {
        let changed = false;

        // 1. Kiểm tra các ảnh đang chọn ở local: nếu trên đám mây đã BỎ CHỌN thì hủy chọn ngay ở local
        for (const [id, localItem] of this.selectionsMap.entries()) {
          const cloudItem = cloudDraft[id];
          if (!cloudItem || !cloudItem.selected) {
            if (localItem.selected || localItem.priority) {
              this.selectionsMap.set(id, {
                ...localItem,
                selected: false,
                priority: false,
                updatedAt: cloudTime,
              });
              this.galleryGrid?.updateCardState(id, this.selectionsMap.get(id));
              changed = true;
            }
          }
        }

        // 2. Cập nhật các ảnh đang chọn trên đám mây
        for (const [id, cloudItem] of Object.entries(cloudDraft)) {
          const current = this.selectionsMap.get(id);
          const isSel = Boolean(cloudItem.selected);
          const isPri = Boolean(cloudItem.priority);
          const note = cloudItem.note || '';

          if (!current || current.selected !== isSel || current.priority !== isPri || current.note !== note) {
            this.selectionsMap.set(id, {
              selected: isSel,
              priority: isPri,
              tags: cloudItem.tags || [],
              note: note,
              updatedAt: cloudItem.updatedAt || cloudTime,
            });
            this.galleryGrid?.updateCardState(id, this.selectionsMap.get(id));
            changed = true;
          }
        }

        this.lastCloudUpdatedAt = cloudTime;
        if (changed) {
          StorageManager.saveDraft(this.folderId, this.selectionsMap);
          this.updateCounters();
          if (this.lightbox?.isOpen) {
            this.lightbox.syncControls(true);
          }
          if (showToastMsg) {
            this.showToast('✨ Đã cập nhật ảnh chọn mới từ thiết bị khác!');
          }
        }
      }
      this.setCloudSyncStatus('synced', 'Đã đồng bộ');
    } catch (err) {
      console.warn('Lỗi kéo dữ liệu đám mây:', err);
    } finally {
      this.isSyncing = false;
    }
  }

  async syncCloudNow(showToastMsg = true) {
    this.setCloudSyncStatus('syncing', 'Đang đồng bộ...');
    await this.pullCloudChanges(showToastMsg);
    // Sau khi kéo, nếu local có thao tác mới hơn đám mây thì đẩy lên
    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
    if (webhookUrl && this.folderId && this.lastLocalActionTime > this.lastCloudUpdatedAt) {
      await StorageManager.saveCloudDraft(webhookUrl, this.folderId, this.clientName, this.selectionsMap);
    }
    this.setCloudSyncStatus('synced', 'Đã đồng bộ');
    if (showToastMsg) {
      this.showToast('☁️ Đã đồng bộ với đám mây!');
    }
  }

  async refreshAlbum() {
    if (!this.folderId) return;
    this.showToast('Đang tải lại danh sách ảnh mới nhất từ Google Drive...');
    clearAlbumCache(this.folderId);
    await this.loadAlbumData(true);
  }

  updateCounters() {
    let selCount = 0;
    let priorityCount = 0;
    let noteCount = 0;

    for (const p of this.allPhotos) {
      const s = this.getPhotoSelection(p.id);
      if (s.selected) selCount++;
      if (s.priority) priorityCount++;
      if ((s.tags && s.tags.length) || (s.note && s.note.trim())) noteCount++;
    }

    this.counterSelected.textContent = selCount;
    this.countPillAll.textContent = this.allPhotos.length;
    this.countPillSelected.textContent = selCount;
    this.countPillUnselected.textContent = Math.max(0, this.allPhotos.length - selCount);
    this.countPillPriority.textContent = priorityCount;
    this.countPillNote.textContent = noteCount;

    // Theo dõi định mức gói chụp (limit) và tính phụ phí 25.000 VNĐ / ảnh
    if (this.limit > 0 && selCount > this.limit) {
      const extra = selCount - this.limit;
      const fee = extra * 25000;
      this.counterPill.classList.add('is-over-limit');
      this.counterWarning.textContent = `(+${extra} ảnh phát sinh • +${fee.toLocaleString('vi-VN')} đ)`;
      this.counterWarning.classList.remove('hidden');
    } else {
      this.counterPill.classList.remove('is-over-limit');
      this.counterWarning.classList.add('hidden');
    }

    this.updateSelectedToolbar();
  }

  // --- Chế độ Chạm Bỏ Chọn Nhanh (Quick Toggle Mode) & Thao tác hàng loạt ---
  toggleQuickMode(forceState = null) {
    this.quickToggleMode = typeof forceState === 'boolean' ? forceState : !this.quickToggleMode;
    this.galleryGridEl?.classList.toggle('is-quick-mode', this.quickToggleMode);
    this.updateQuickModeUI();
    if (this.quickToggleMode) {
      this.showToast('⚡ Đã bật Chế độ chạm nhanh! Chạm vào bất kỳ ảnh nào để chọn / bỏ chọn.');
    } else {
      this.showToast('🔍 Đã tắt Chế độ chọn nhanh (Chạm ảnh để xem phóng to).');
    }
  }

  updateQuickModeUI() {
    if (this.btnToggleQuickDeselect) {
      this.btnToggleQuickDeselect.classList.toggle('is-active', this.quickToggleMode);
      if (this.quickToggleLabel) {
        this.quickToggleLabel.textContent = this.quickToggleMode
          ? '⚡ Chế độ chạm bỏ chọn nhanh: ĐANG BẬT'
          : '⚡ Chế độ chạm bỏ chọn nhanh: TẮT';
      }
    }
    if (this.barBtnQuickMode) {
      this.barBtnQuickMode.classList.toggle('is-active', this.quickToggleMode);
      this.barBtnQuickMode.innerHTML = this.quickToggleMode
        ? '<span>⚡ Chạm nhanh: BẬT</span>'
        : '<span>⚡ Chạm nhanh: TẮT</span>';
    }
  }

  updateSelectedToolbar() {
    if (!this.selectedToolbar) return;
    let selCount = 0;
    for (const p of this.allPhotos) {
      if (this.getPhotoSelection(p.id).selected) selCount++;
    }
    if (this.selectedToolbarCount) {
      this.selectedToolbarCount.textContent = `${selCount} ảnh đã chọn`;
    }
    // Hiển thị thanh công cụ khi đang ở tab "Đã chọn ♥"
    const isViewingSelected = this.currentFilter === 'selected';
    this.selectedToolbar.classList.toggle('hidden', !isViewingSelected);
  }

  deselectAllPhotos() {
    let selCount = 0;
    for (const [id, s] of this.selectionsMap.entries()) {
      if (s.selected) selCount++;
    }
    if (selCount === 0) {
      this.showToast('Hiện tại chưa có bức ảnh nào được chọn!');
      return;
    }
    if (!confirm(`Bạn có chắc chắn muốn bỏ chọn tất cả ${selCount} bức ảnh đã chọn không?`)) {
      return;
    }

    this.lastLocalActionTime = Date.now();
    const now = Date.now();
    for (const [id, s] of this.selectionsMap.entries()) {
      if (s.selected || s.priority) {
        this.selectionsMap.set(id, {
          ...s,
          selected: false,
          priority: false,
          updatedAt: now,
        });
        this.galleryGrid.updateCardState(id, this.getPhotoSelection(id));
      }
    }

    this.updateCounters();
    this.scheduleSaveDraft();
    this.updateSelectedToolbar();
    if (this.currentFilter === 'selected') {
      this.applyFilters();
    }
    this.showToast(`✨ Đã bỏ chọn toàn bộ ${selCount} ảnh thành công!`);
  }

  // --- Lightbox ---
  initLightbox() {
    const modalEl = document.getElementById('lightbox-modal');
    this.lightbox = new LightboxModal(modalEl, {
      quickTags: STUDIO_CONFIG.quickTags,
      allowDownload: this.allowDownload,
      callbacks: {
        getSelection: (id) => this.getPhotoSelection(id),
        onToggleHeart: (id) => this.toggleHeart(id),
        onToggleStar: (id) => this.toggleStar(id),
        onToggleTag: (id, tag) => this.toggleTag(id, tag),
        onUpdateNote: (id, text) => this.updateNote(id, text),
        onFindFaceFromPhoto: (photo) => this.startFaceDetectionWithSample(photo),
        onDownloadPhoto: (photo) => this.downloadSinglePhoto(photo),
        showToast: (msg, type) => this.showToast(msg, type),
      },
    });
  }

  openLightboxAt(index, focusNote = false) {
    this.lightbox.open(this.filteredPhotos, index, focusNote);
  }

  // --- Lọc Khuôn Mặt ---
  initFaceModal() {
    this.faceModal = document.getElementById('face-modal');
    this.facePickerGrid = document.getElementById('face-picker-grid');
    this.faceStepPick = document.getElementById('face-step-pick');
    this.faceStepSelect = document.getElementById('face-step-select');
    this.faceStepScan = document.getElementById('face-step-scan');
    this.faceSampleImg = document.getElementById('face-sample-img');
    this.faceBoxesOverlay = document.getElementById('face-boxes-overlay');
    this.faceScanProgressFill = document.getElementById('face-scan-progress-fill');
    this.faceScanPercentText = document.getElementById('face-scan-percent-text');
    this.faceScanStatusTitle = document.getElementById('face-scan-status-title');
    this.faceScanStatusDesc = document.getElementById('face-scan-status-desc');
    this.faceScanBadge = document.getElementById('face-scan-badge');
    this.faceStatScannedCount = document.getElementById('face-stat-scanned-count');
    this.faceStatFacesCount = document.getElementById('face-stat-faces-count');
    this.faceStatClustersCount = document.getElementById('face-stat-clusters-count');
    this.faceBtnBack = document.getElementById('face-btn-back');
    this.faceBtnBackground = document.getElementById('face-btn-background');

    // GitHub Actions tracking elements
    this.faceGhActionsArea = document.getElementById('face-gh-actions-area');
    this.faceGhRuntime = document.getElementById('face-gh-runtime');
    this.faceGhLogLink = document.getElementById('face-gh-log-link');
    this.faceGhRefreshBtn = document.getElementById('face-gh-refresh-btn');
    this.faceBtnStartBrowserAi = document.getElementById('face-btn-start-browser-ai');
    this.faceNoScanArea = document.getElementById('face-no-scan-area');
    this.faceBtnTriggerBrowserAi = document.getElementById('face-btn-trigger-browser-ai');
    this.ghActionsPollTimer = null;

    // Các nút thao tác quét: Bắt đầu, Tạm dừng, Tiếp tục, Dừng & Gom cụm
    this.faceScanControlsBar = document.getElementById('face-scan-controls-bar');
    this.faceBtnStartScan = document.getElementById('face-btn-start-scan');
    this.faceBtnPauseScan = document.getElementById('face-btn-pause-scan');
    this.faceBtnResumeScan = document.getElementById('face-btn-resume-scan');
    this.faceBtnStopScan = document.getElementById('face-btn-stop-scan');
    this.faceBtnFooterPause = document.getElementById('face-btn-footer-pause');
    this.faceBtnFooterResume = document.getElementById('face-btn-footer-resume');
    this.isPausedFace = false;
    this.lastScannedCount = 0;

    // Clusters step elements
    this.faceStepClusters = document.getElementById('face-step-clusters');
    this.faceClustersGrid = document.getElementById('face-clusters-grid');
    this.faceBtnRescan = document.getElementById('face-btn-rescan');
    this.faceBtnCustomSample = document.getElementById('face-btn-custom-sample');
    this.faceBtnSyncCloud = document.getElementById('face-btn-sync-cloud');
    this.faceBtnDownloadJson = document.getElementById('face-btn-download-json');
    this.faceClusters = [];

    // Floating background scan pill
    this.faceFloatingPill = document.getElementById('face-floating-pill');
    this.facePillText = document.getElementById('face-pill-text');
    this.facePillFill = document.getElementById('face-pill-fill');
    this.facePillOpen = document.getElementById('face-pill-open');
    this.facePillPauseBtn = document.getElementById('face-pill-pause-btn');
    this.isScanningFace = false;

    document.getElementById('btn-open-face-modal').addEventListener('click', () => {
      this.openFaceModal();
    });

    document.getElementById('face-modal-close').addEventListener('click', () => {
      if (this.isScanningFace) {
        this.minimizeFaceModal();
      } else {
        this.closeFaceModal();
      }
    });

    document.getElementById('face-btn-cancel').addEventListener('click', () => {
      this.closeFaceModal();
    });

    this.faceBtnBack.addEventListener('click', () => {
      if (this.faceClusters && this.faceClusters.length > 0) {
        this.showFaceStep('clusters');
      } else {
        this.showFaceStep('pick');
      }
    });

    this.faceBtnBackground?.addEventListener('click', () => {
      this.minimizeFaceModal();
    });

    this.facePillOpen?.addEventListener('click', () => {
      this.restoreFaceModal();
    });

    this.facePillPauseBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isPausedFace) {
        this.resumeFaceScan();
      } else {
        this.pauseFaceScan();
      }
    });

    this.faceBtnStartScan?.addEventListener('click', () => {
      this.startAutoClusterScan();
    });

    this.faceBtnPauseScan?.addEventListener('click', () => {
      this.pauseFaceScan();
    });

    this.faceBtnFooterPause?.addEventListener('click', () => {
      this.pauseFaceScan();
    });

    this.faceBtnResumeScan?.addEventListener('click', () => {
      this.resumeFaceScan();
    });

    this.faceBtnFooterResume?.addEventListener('click', () => {
      this.resumeFaceScan();
    });

    this.faceBtnStopScan?.addEventListener('click', () => {
      this.stopFaceScan();
    });

    this.faceBtnRescan?.addEventListener('click', () => {
      this.startAutoClusterScan();
    });

    this.faceBtnSyncCloud?.addEventListener('click', async () => {
      await this.syncClustersToCloud();
    });

    this.faceBtnDownloadJson?.addEventListener('click', () => {
      this.downloadClustersJson();
    });

    this.faceBtnCustomSample?.addEventListener('click', () => {
      this.showFaceStep('pick');
      this.renderFacePickerGrid();
    });

    this.faceGhRefreshBtn?.addEventListener('click', () => {
      this.checkAndHandleGitHubActions(true);
    });

    this.faceBtnStartBrowserAi?.addEventListener('click', () => {
      if (this.ghActionsPollTimer) {
        clearInterval(this.ghActionsPollTimer);
        this.ghActionsPollTimer = null;
      }
      if (this.faceGhActionsArea) this.faceGhActionsArea.classList.add('hidden');
      this.startAutoClusterScan();
    });

    this.faceBtnTriggerBrowserAi?.addEventListener('click', () => {
      if (this.faceNoScanArea) this.faceNoScanArea.classList.add('hidden');
      this.startAutoClusterScan();
    });
  }

  updateFaceScanControls(state) {
    if (!this.faceBtnStartScan) return;
    if (state === 'running') {
      this.faceBtnStartScan.classList.add('hidden');
      this.faceBtnPauseScan?.classList.remove('hidden');
      this.faceBtnResumeScan?.classList.add('hidden');
      this.faceBtnStopScan?.classList.remove('hidden');
      this.faceBtnFooterPause?.classList.remove('hidden');
      this.faceBtnFooterResume?.classList.add('hidden');
      if (this.facePillPauseBtn) this.facePillPauseBtn.textContent = '⏸️';
    } else if (state === 'paused') {
      this.faceBtnStartScan.classList.add('hidden');
      this.faceBtnPauseScan?.classList.add('hidden');
      this.faceBtnResumeScan?.classList.remove('hidden');
      this.faceBtnStopScan?.classList.remove('hidden');
      this.faceBtnFooterPause?.classList.add('hidden');
      this.faceBtnFooterResume?.classList.remove('hidden');
      if (this.facePillPauseBtn) this.facePillPauseBtn.textContent = '▶️';
    } else {
      // idle or done
      this.faceBtnStartScan.classList.remove('hidden');
      this.faceBtnPauseScan?.classList.add('hidden');
      this.faceBtnResumeScan?.classList.add('hidden');
      this.faceBtnStopScan?.classList.add('hidden');
      this.faceBtnFooterPause?.classList.add('hidden');
      this.faceBtnFooterResume?.classList.add('hidden');
    }
  }

  pauseFaceScan() {
    if (!this.isScanningFace) return;
    this.isPausedFace = true;
    this.faceEngine?.pauseScan();
    this.updateFaceScanControls('paused');
    this.updateFaceScanUI({
      statusTitle: 'Đã tạm dừng quét khuôn mặt',
      statusDesc: 'Tiến trình quét đang tạm dừng. Bấm "Tiếp tục quét" để AI tiếp tục nhận diện ảnh tiếp theo.',
      badge: 'Tạm dừng',
      badgeType: 'warning',
    });
    if (this.facePillText) {
      this.facePillText.textContent = `⏸️ Đã tạm dừng: ${this.lastScannedCount || 0}/${this.allPhotos ? this.allPhotos.length : 0}`;
    }
    this.showToast('Đã tạm dừng quét!', 'info');
  }

  resumeFaceScan() {
    if (!this.isScanningFace) return;
    this.isPausedFace = false;
    this.faceEngine?.resumeScan();
    this.updateFaceScanControls('running');
    this.updateFaceScanUI({
      statusTitle: 'Đang tiếp tục quét & nhận diện...',
      statusDesc: 'Đang gửi ảnh tới mạng nơ-ron WebGL/GPU để phân tích...',
      badge: 'Đang quét',
      badgeType: 'active',
    });
    this.showToast('Tiếp tục quét AI...', 'info');
  }

  stopFaceScan() {
    if (!this.isScanningFace) return;
    this.faceEngine?.stopScan();
    this.isPausedFace = false;
    this.showToast('Đang dừng và gom nhóm các khuôn mặt đã phát hiện...', 'info');
  }

  minimizeFaceModal() {
    this.faceModal.classList.add('hidden');
    document.body.style.overflow = '';
    if (this.isScanningFace && this.faceFloatingPill) {
      this.faceFloatingPill.classList.remove('hidden');
      this.showToast('Hệ thống đang quét ngầm. Bạn có thể thoải mái chọn và xem ảnh!', 'info');
    }
  }

  restoreFaceModal() {
    if (this.faceFloatingPill) this.faceFloatingPill.classList.add('hidden');
    this.faceModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  async openFaceModal() {
    this.faceModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // 1. Nếu đã có dữ liệu cụm người trong bộ nhớ
    if (this.faceClusters && this.faceClusters.length > 0) {
      this.showFaceStep('clusters');
      this.renderFaceClustersGrid();
      return;
    }

    // 2. Thử nạp lại file faces_<slug>.json từ GitHub Pages nếu vừa hoàn thành
    const hasClusters = await this.loadCachedClusters();
    if (hasClusters && this.faceClusters && this.faceClusters.length > 0) {
      this.showFaceStep('clusters');
      this.renderFaceClustersGrid();
      return;
    }

    // 3. Chưa có kết quả: Hiển thị giao diện kiểm tra GitHub Actions
    this.showFaceStep('scan');
    this.checkAndHandleGitHubActions();
  }

  async checkGitHubActionsStatus() {
    try {
      const res = await fetch('https://api.github.com/repos/hoangdiep99/DIPchonanh/actions/runs?event=workflow_dispatch&per_page=1', {
        headers: { Accept: 'application/vnd.github.v3+json' },
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.workflow_runs && data.workflow_runs.length > 0) {
        return data.workflow_runs[0];
      }
    } catch (e) {
      console.warn('Lỗi kiểm tra GitHub Actions status:', e);
    }
    return null;
  }

  async checkAndHandleGitHubActions(forceManual = false) {
    if (this.faceGhActionsArea) this.faceGhActionsArea.classList.add('hidden');
    if (this.faceNoScanArea) this.faceNoScanArea.classList.add('hidden');

    this.updateFaceScanUI({
      percent: 10,
      statusTitle: 'Đang kiểm tra tiến trình GitHub Actions...',
      statusDesc: 'Đang kết nối máy chủ GitHub Cloud kiểm tra trạng thái AI...',
      badge: 'Kiểm tra',
      badgeType: 'info',
      scanned: 0,
      total: this.allPhotos ? this.allPhotos.length : 0,
      faces: 0,
      clusters: 0,
    });

    const hasClusters = await this.loadCachedClusters();
    if (hasClusters && this.faceClusters && this.faceClusters.length > 0) {
      this.showFaceStep('clusters');
      this.renderFaceClustersGrid();
      this.showToast('Đã tải thành công danh sách khuôn mặt từ GitHub!', 'success');
      return;
    }

    try {
      const run = await this.checkGitHubActionsStatus();
      if (run && (run.status === 'in_progress' || run.status === 'queued')) {
        this.renderGitHubActionsRunning(run);
      } else {
        this.renderNoGitHubActionsRunning(run);
      }
    } catch (err) {
      console.warn('Lỗi kiểm tra GitHub Actions:', err);
      this.renderNoGitHubActionsRunning(null);
    }
  }

  renderGitHubActionsRunning(run) {
    const startTime = new Date(run.created_at).getTime();
    const elapsedMinutes = Math.max(1, Math.round((Date.now() - startTime) / 60000));
    const totalPhotos = this.allPhotos ? this.allPhotos.length : 0;

    if (this.faceGhActionsArea) this.faceGhActionsArea.classList.remove('hidden');
    if (this.faceNoScanArea) this.faceNoScanArea.classList.add('hidden');
    if (this.faceGhLogLink) this.faceGhLogLink.href = run.html_url;
    if (this.faceGhRuntime) {
      this.faceGhRuntime.textContent = `⚡ Máy chủ Cloud đã chạy: ${elapsedMinutes} phút (Bắt đầu: ${new Date(run.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })})`;
    }

    const estimatedPct = Math.min(95, Math.max(15, Math.round((elapsedMinutes / 60) * 100)));

    this.updateFaceScanUI({
      percent: estimatedPct,
      statusTitle: 'InsightFace (ArcFace 99.8%) Đang Quét Trên GitHub Actions',
      statusDesc: `Hệ thống siêu máy chủ Cloud đang quét nhận diện toàn bộ ${totalPhotos} ảnh. Bạn có thể bấm nút bên dưới để xem nhật ký trực tiếp hoặc đợi hệ thống tự động đồng bộ kết quả.`,
      badge: `☁️ GitHub Actions (${elapsedMinutes}m)`,
      badgeType: 'active',
      scanned: Math.round((estimatedPct / 100) * totalPhotos),
      total: totalPhotos,
      faces: '--',
      clusters: '--',
    });

    if (this.ghActionsPollTimer) clearInterval(this.ghActionsPollTimer);
    this.ghActionsPollTimer = setInterval(async () => {
      if (document.visibilityState !== 'visible' || !this.faceModal || this.faceModal.classList.contains('hidden')) return;

      const loaded = await this.loadCachedClusters();
      if (loaded && this.faceClusters && this.faceClusters.length > 0) {
        clearInterval(this.ghActionsPollTimer);
        this.ghActionsPollTimer = null;
        this.showToast('🎉 GitHub Actions đã quét xong toàn bộ album!', 'success');
        this.showFaceStep('clusters');
        this.renderFaceClustersGrid();
        return;
      }

      const updatedRun = await this.checkGitHubActionsStatus();
      if (updatedRun) {
        if (updatedRun.status === 'completed') {
          clearInterval(this.ghActionsPollTimer);
          this.ghActionsPollTimer = null;
          if (updatedRun.conclusion === 'success') {
            await this.loadCachedClusters();
            this.showToast('🎉 GitHub Actions vừa quét xong! Đang nạp danh sách...', 'success');
            this.showFaceStep('clusters');
            this.renderFaceClustersGrid();
          } else {
            this.renderNoGitHubActionsRunning(updatedRun);
          }
        } else {
          const nowElapsed = Math.max(1, Math.round((Date.now() - new Date(updatedRun.created_at).getTime()) / 60000));
          if (this.faceGhRuntime) {
            this.faceGhRuntime.textContent = `⚡ Máy chủ Cloud đã chạy: ${nowElapsed} phút`;
          }
          const nowPct = Math.min(95, Math.max(15, Math.round((nowElapsed / 60) * 100)));
          if (this.faceScanPercentText) this.faceScanPercentText.textContent = `${nowPct}%`;
          if (this.faceScanProgressFill) this.faceScanProgressFill.style.width = `${nowPct}%`;
          if (this.faceScanBadge) this.faceScanBadge.textContent = `☁️ GitHub Actions (${nowElapsed}m)`;
        }
      }
    }, 12000);
  }

  renderNoGitHubActionsRunning(run) {
    if (this.ghActionsPollTimer) {
      clearInterval(this.ghActionsPollTimer);
      this.ghActionsPollTimer = null;
    }
    if (this.faceGhActionsArea) this.faceGhActionsArea.classList.add('hidden');
    if (this.faceNoScanArea) this.faceNoScanArea.classList.remove('hidden');
    this.updateFaceScanControls('idle');

    const totalPhotos = this.allPhotos ? this.allPhotos.length : 0;
    const isFailed = run && run.conclusion === 'failure';

    this.updateFaceScanUI({
      percent: 0,
      statusTitle: isFailed ? 'Tiến trình GitHub Actions trước đó gặp lỗi' : 'Chưa có dữ liệu khuôn mặt sẵn cho album này',
      statusDesc: isFailed
        ? 'Tiến trình quét trên GitHub Actions trước đó bị gián đoạn. Bạn có thể bấm quét ngay bằng AI Web trình duyệt dưới đây.'
        : 'Album này chưa có dữ liệu quét sẵn. Bạn có thể chọn quét nhanh bằng AI Web trên máy hoặc mở GitHub Actions để quét chuẩn ArcFace (99.8%).',
      badge: isFailed ? 'Lỗi GitHub' : 'Chưa quét',
      badgeType: isFailed ? 'warning' : 'info',
      scanned: 0,
      total: totalPhotos,
      faces: 0,
      clusters: 0,
    });
  }

  closeFaceModal() {
    if (this.ghActionsPollTimer) {
      clearInterval(this.ghActionsPollTimer);
      this.ghActionsPollTimer = null;
    }
    if (this.isScanningFace) {
      this.faceEngine?.stopScan();
      this.isScanningFace = false;
      this.isPausedFace = false;
      this.updateFaceScanControls('idle');
    }
    this.faceModal.classList.add('hidden');
    document.body.style.overflow = '';
    if (this.faceFloatingPill) this.faceFloatingPill.classList.add('hidden');
  }

  showFaceStep(step) {
    if (this.faceStepClusters) this.faceStepClusters.classList.toggle('hidden', step !== 'clusters');
    this.faceStepPick.classList.toggle('hidden', step !== 'pick');
    this.faceStepSelect.classList.toggle('hidden', step !== 'select');
    this.faceStepScan.classList.toggle('hidden', step !== 'scan');
    this.faceBtnBack.classList.toggle('hidden', step === 'clusters' || (step === 'scan' && !this.faceClusters.length));
    if (this.faceBtnBackground) {
      this.faceBtnBackground.classList.toggle('hidden', step !== 'scan');
    }

    const sub = document.getElementById('face-modal-subtitle');
    if (step === 'clusters') sub.textContent = 'Danh sách các khuôn mặt khác nhau được phát hiện trong album';
    if (step === 'pick') sub.textContent = 'Chạm vào 1 bức ảnh mẫu để tìm người cụ thể';
    if (step === 'select') sub.textContent = 'Chạm vào ô vuông khuôn mặt người cần tìm';
    if (step === 'scan') sub.textContent = 'Hệ thống đang quét toàn bộ ảnh...';
  }

  updateFaceScanUI({ percent = 0, statusTitle = '', statusDesc = '', badge = '', badgeType = 'info', scanned = 0, total = 0, faces = 0, clusters = 0 }) {
    if (this.faceScanProgressFill) {
      this.faceScanProgressFill.style.width = `${percent}%`;
    }
    if (this.faceScanPercentText) {
      this.faceScanPercentText.textContent = `${percent}%`;
    }
    if (statusTitle && this.faceScanStatusTitle) {
      this.faceScanStatusTitle.textContent = statusTitle;
    }
    if (statusDesc && this.faceScanStatusDesc) {
      this.faceScanStatusDesc.textContent = statusDesc;
    }
    if (badge && this.faceScanBadge) {
      this.faceScanBadge.textContent = badge;
      this.faceScanBadge.className = `face-scan-badge badge-${badgeType}`;
    }
    if (this.faceStatScannedCount) {
      this.faceStatScannedCount.textContent = `${scanned} / ${total}`;
    }
    if (this.faceStatFacesCount) {
      this.faceStatFacesCount.textContent = `${faces}`;
    }
    if (this.faceStatClustersCount) {
      this.faceStatClustersCount.textContent = `${clusters}`;
    }
    if (this.facePillText && this.facePillFill) {
      const faceText = faces > 0 ? ` • ${faces} mặt` : '';
      this.facePillText.textContent = `Đang quét AI: ${scanned}/${total} (${percent}%)${faceText}`;
      this.facePillFill.style.width = `${percent}%`;
    }
  }

  async startAutoClusterScan() {
    this.showFaceStep('scan');
    if (this.faceNoScanArea) this.faceNoScanArea.classList.add('hidden');
    if (this.faceGhActionsArea) this.faceGhActionsArea.classList.add('hidden');
    this.isScanningFace = true;
    this.isPausedFace = false;
    this.updateFaceScanControls('running');

    const totalPhotos = this.allPhotos ? this.allPhotos.length : 0;
    this.updateFaceScanUI({
      percent: 0,
      statusTitle: 'Đang khởi động AI...',
      statusDesc: 'Nạp mô hình nhận diện khuôn mặt và kiểm tra bộ nhớ đệm cache...',
      badge: 'Khởi động',
      badgeType: 'warning',
      scanned: 0,
      total: totalPhotos,
      faces: 0,
      clusters: 0,
    });

    try {
      const defaultThreshold = STUDIO_CONFIG.faceAI.defaultThreshold || 0.52;
      const clusters = await this.faceEngine.scanAndClusterAlbum(
        this.allPhotos,
        (p) => {
          const total = p.total || totalPhotos || 1;
          const current = p.current || 0;
          const pct = Math.min(100, Math.round((current / total) * 100));
          const faces = p.foundFaces || 0;
          const clustCount = p.clustersCount || 0;

          if (p.phase === 'paused') {
            this.updateFaceScanControls('paused');
            this.updateFaceScanUI({
              percent: pct,
              statusTitle: 'Đã tạm dừng quét khuôn mặt',
              statusDesc: p.msg || `Đang tạm dừng (${current}/${total} ảnh). Bấm "Tiếp tục quét" để chạy tiếp.`,
              badge: 'Tạm dừng',
              badgeType: 'warning',
              scanned: current,
              total,
              faces,
              clusters: clustCount,
            });
            return;
          }

          if (p.phase === 'init_model') {
            this.updateFaceScanControls('running');
            this.updateFaceScanUI({
              percent: 5,
              statusTitle: 'Đang nạp mô hình AI...',
              statusDesc: p.msg || 'Khởi động mạng nơ-ron WebGL/GPU...',
              badge: 'Tải AI Model',
              badgeType: 'warning',
              scanned: 0,
              total,
              faces: 0,
              clusters: 0,
            });
          } else if (p.phase === 'cache_loaded') {
            this.lastScannedCount = current;
            this.updateFaceScanControls('running');
            this.updateFaceScanUI({
              percent: pct,
              statusTitle: 'Đang đọc bộ nhớ đệm (IndexedDB)...',
              statusDesc: p.msg || `Đã nạp ${current}/${total} ảnh từ cache...`,
              badge: 'Đọc Cache',
              badgeType: 'info',
              scanned: current,
              total,
              faces,
              clusters: clustCount,
            });
          } else if (p.phase === 'ai_scanning') {
            this.lastScannedCount = current;
            this.updateFaceScanControls('running');
            this.updateFaceScanUI({
              percent: pct,
              statusTitle: 'Đang quét & nhận diện khuôn mặt...',
              statusDesc: p.msg || `Đang quét lô ảnh ${current}/${total}...`,
              badge: 'Đang quét',
              badgeType: 'active',
              scanned: current,
              total,
              faces,
              clusters: clustCount,
            });
          } else if (p.phase === 'clustering') {
            this.updateFaceScanControls('running');
            this.updateFaceScanUI({
              percent: 95,
              statusTitle: 'Đang phân tích & gom nhóm người...',
              statusDesc: p.msg || 'So sánh đặc trưng khuôn mặt các nhân vật...',
              badge: 'Gom cụm AI',
              badgeType: 'active',
              scanned: total,
              total,
              faces,
              clusters: clustCount,
            });
          } else if (p.phase === 'done') {
            this.updateFaceScanUI({
              percent: 100,
              statusTitle: 'Hoàn tất quét & gom nhóm!',
              statusDesc: p.msg || `Tìm thấy ${clustCount} nhóm người khác nhau.`,
              badge: 'Hoàn tất',
              badgeType: 'success',
              scanned: total,
              total,
              faces,
              clusters: clustCount,
            });
          }
        },
        defaultThreshold
      );

      this.faceClusters = clusters;
      this.isScanningFace = false;
      this.isPausedFace = false;
      this.updateFaceScanControls('idle');
      this.saveCachedClusters();
      this.renderPeopleBar();
      if (this.faceFloatingPill) this.faceFloatingPill.classList.add('hidden');

      if (!clusters || clusters.length === 0) {
        alert('Không tìm thấy khuôn mặt rõ nét nào trong các ảnh đã quét.');
        this.closeFaceModal();
        return;
      }

      this.restoreFaceModal();
      this.showFaceStep('clusters');
      this.renderFaceClustersGrid();
      this.showToast(`Phát hiện ${clusters.length} người khác nhau trong album!`, 'success');
    } catch (err) {
      this.isScanningFace = false;
      this.isPausedFace = false;
      this.updateFaceScanControls('idle');
      console.error(err);
      alert('Lỗi quét khuôn mặt: ' + err.message);
      this.closeFaceModal();
    } finally {
      this.isScanningFace = false;
      this.isPausedFace = false;
      this.updateFaceScanControls('idle');
    }
  }

  async syncClustersToCloud() {
    if (!this.faceClusters || this.faceClusters.length === 0) {
      this.showToast('Chưa có dữ liệu khuôn mặt để đồng bộ!', 'warning');
      return;
    }
    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
    if (!webhookUrl) {
      this.showToast('Chưa cấu hình Google Apps Script Webhook trong config.js', 'warning');
      return;
    }

    const slug = this.slug || new URLSearchParams(window.location.search).get('k') || '';
    const clusterData = this.faceClusters.map((c) => ({
      id: c.id,
      label: c.label,
      avatarUrl: c.avatarUrl,
      photoCount: c.photoCount,
      photoIds: Array.from(c.photoIds),
    }));

    try {
      this.showToast('☁️ Đang đồng bộ cụm người lên đám mây...', 'info');
      await fetch(webhookUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_clusters',
          folderId: this.folderId,
          slug: slug,
          clusters: clusterData,
        }),
      });
      this.showToast(`🎉 Đã đồng bộ ${clusterData.length} cụm người lên đám mây! Mọi thiết bị khác mở lên sẽ có ngay.`, 'success');
    } catch (err) {
      console.warn('Lỗi đồng bộ đám mây:', err);
      this.showToast('Không thể kết nối đám mây: ' + err.message, 'error');
    }
  }

  downloadClustersJson() {
    if (!this.faceClusters || this.faceClusters.length === 0) {
      this.showToast('Chưa có dữ liệu khuôn mặt để tải!', 'warning');
      return;
    }
    const slug = this.slug || new URLSearchParams(window.location.search).get('k') || 'album';
    const clusterData = this.faceClusters.map((c) => ({
      id: c.id,
      label: c.label,
      avatarUrl: c.avatarUrl,
      photoCount: c.photoCount,
      photoIds: Array.from(c.photoIds),
    }));

    const exportObj = {
      slug: slug,
      folderId: this.folderId,
      totalPhotos: this.allPhotos ? this.allPhotos.length : 0,
      totalClusters: clusterData.length,
      createdAt: new Date().toISOString(),
      clusters: clusterData,
    };

    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `faces_${slug}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.showToast(`Đã tải file faces_${slug}.json! Bạn có thể lưu vào thư mục data/ trên GitHub.`, 'success');
  }

  saveCachedClusters() {
    if (!this.faceClusters || this.faceClusters.length === 0) return;
    const slug = this.slug || new URLSearchParams(window.location.search).get('k') || '';
    const clusterData = this.faceClusters.map((c) => ({
      id: c.id,
      label: c.label,
      avatarUrl: c.avatarUrl,
      photoCount: c.photoCount,
      photoIds: Array.from(c.photoIds),
    }));

    try {
      const key = `studio_clusters_${this.folderId || 'demo'}`;
      localStorage.setItem(key, JSON.stringify(clusterData));
      if (slug) {
        localStorage.setItem(`studio_clusters_${slug}`, JSON.stringify(clusterData));
      }
    } catch {
      // ignore
    }

    // Tự động đồng bộ ngầm lên Webhook đám mây (nếu có Webhook)
    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
    if (webhookUrl && (slug || this.folderId)) {
      fetch(webhookUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_clusters',
          folderId: this.folderId,
          slug: slug,
          clusters: clusterData,
        }),
      }).catch(() => {});
    }
  }

  async loadCachedClusters() {
    let slug = this.slug || new URLSearchParams(window.location.search).get('k') || new URLSearchParams(window.location.search).get('album') || '';
    const folderId = this.folderId;
    if (!slug && folderId) {
      const defaultList = STUDIO_CONFIG.defaultAlbums || [];
      const found = defaultList.find((a) => a.folderId === folderId);
      if (found && found.slug) slug = found.slug;
    }
    let loadedFromGitHub = false;

    // 1. Thử tải dữ liệu phân loại AI InsightFace có sẵn từ GitHub (nếu Studio đã quét trước)
    const jsonPaths = [];
    if (slug) jsonPaths.push(`data/faces_${slug}.json`);
    if (folderId) jsonPaths.push(`data/faces_${folderId}.json`);

    for (const path of jsonPaths) {
      try {
        const res = await fetch(`${path}?t=${Date.now()}`);
        if (res.ok) {
          const json = await res.json();
          if (json && Array.isArray(json.clusters) && json.clusters.length > 0) {
            this.faceClusters = json.clusters.map((item) => ({
              ...item,
              photoIds: new Set(item.photoIds || []),
            }));
            const key = `studio_clusters_${this.folderId || 'demo'}`;
            try {
              localStorage.setItem(key, JSON.stringify(json.clusters));
              if (slug) localStorage.setItem(`studio_clusters_${slug}`, JSON.stringify(json.clusters));
            } catch (e) {}
            this.renderPeopleBar();
            this.peopleBar?.classList.remove('hidden');
            console.log(`✨ Đã nạp ${this.faceClusters.length} nhóm khuôn mặt AI InsightFace chuẩn xác từ GitHub:`, path);
            loadedFromGitHub = true;
            return true;
          }
        }
      } catch (e) {
        // file chưa có trên GitHub
      }
    }

    if (loadedFromGitHub) return true;

    // 2. Thử nạp từ Webhook đám mây (Google Apps Script)
    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl || localStorage.getItem('studio_apps_script_url');
    if (webhookUrl && (slug || folderId)) {
      try {
        const syncUrl = `${webhookUrl}${webhookUrl.includes('?') ? '&' : '?'}action=get_clusters&slug=${encodeURIComponent(slug)}&folderId=${encodeURIComponent(folderId || '')}&t=${Date.now()}`;
        const wRes = await fetch(syncUrl);
        if (wRes.ok) {
          const wData = await wRes.json();
          if (wData.status === 'success' && Array.isArray(wData.clusters) && wData.clusters.length > 0) {
            this.faceClusters = wData.clusters.map((item) => ({
              ...item,
              photoIds: new Set(item.photoIds || []),
            }));
            const key = `studio_clusters_${this.folderId || 'demo'}`;
            try {
              localStorage.setItem(key, JSON.stringify(wData.clusters));
              if (slug) localStorage.setItem(`studio_clusters_${slug}`, JSON.stringify(wData.clusters));
            } catch (e) {}
            this.renderPeopleBar();
            this.peopleBar?.classList.remove('hidden');
            console.log(`☁️ Đã nạp ${this.faceClusters.length} nhóm khuôn mặt tự động từ đám mây (Webhook)!`);
            return true;
          }
        }
      } catch (err) {
        // Webhook error ignore
      }
    }

    // 3. Dự phòng: Đọc từ bộ nhớ máy khách (LocalStorage)
    try {
      const key = `studio_clusters_${this.folderId || 'demo'}`;
      let raw = localStorage.getItem(key);
      if (!raw && slug) {
        raw = localStorage.getItem(`studio_clusters_${slug}`);
      }
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.length > 0) {
        this.faceClusters = data.map((item) => ({
          ...item,
          photoIds: new Set(item.photoIds),
        }));
        this.renderPeopleBar();
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  renderPeopleBar() {
    if (!this.peopleBar || !this.peopleChipsList) return;
    if (!this.faceClusters || this.faceClusters.length === 0) {
      this.peopleBar.classList.add('hidden');
      return;
    }

    this.peopleBar.classList.remove('hidden');
    if (this.peopleAllCount) {
      this.peopleAllCount.textContent = this.allPhotos.length;
    }

    if (this.btnPeopleAll) {
      this.btnPeopleAll.classList.toggle('is-active', !this.activeFaceFilter);
    }

    this.peopleChipsList.innerHTML = '';
    for (const cluster of this.faceClusters) {
      const isSelected = this.selectedClusterId === cluster.id;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `people-chip${isSelected ? ' is-active' : ''}`;
      chip.innerHTML = `
        <img src="${cluster.avatarUrl}" class="people-chip-avatar" alt="${cluster.label}">
        <span>${cluster.label}</span>
        <span class="people-count">${cluster.photoCount}</span>
      `;

      // Tự động cắt cận cảnh khuôn mặt cho avatar nếu chưa được crop
      if (cluster.box && cluster.avatarUrl && cluster.avatarUrl.startsWith('http') && this.faceEngine) {
        this.faceEngine.cropFaceAvatar(cluster.avatarUrl, cluster.box).then((cropped) => {
          if (cropped && cropped.startsWith('data:')) {
            cluster.avatarUrl = cropped;
            const img = chip.querySelector('.people-chip-avatar');
            if (img) img.src = cropped;
            this.saveFaceClustersToStorage();
          }
        });
      }

      chip.addEventListener('click', () => {
        if (this.selectedClusterId === cluster.id) {
          this.clearFaceFilter();
        } else {
          this.applyClusterFilter(cluster);
        }
      });

      this.peopleChipsList.appendChild(chip);
    }
  }

  renderFaceClustersGrid() {
    if (!this.faceClustersGrid) return;
    this.faceClustersGrid.innerHTML = '';
    for (const cluster of this.faceClusters) {
      const isSelected = this.selectedClusterId === cluster.id;
      const card = document.createElement('div');
      card.className = `cluster-card${isSelected ? ' is-active' : ''}`;
      card.innerHTML = `
        <div class="cluster-avatar-wrap">
          <img src="${cluster.avatarUrl}" class="cluster-avatar" alt="${cluster.label}">
        </div>
        <span class="cluster-label" title="Bấm để đổi tên (VD: Cô dâu, Chú rể)">${cluster.label} ✏️</span>
        <span class="cluster-count">${cluster.photoCount} ảnh</span>
      `;

      // Tự động cắt cận cảnh khuôn mặt cho avatar nếu chưa được crop
      if (cluster.box && cluster.avatarUrl && cluster.avatarUrl.startsWith('http') && this.faceEngine) {
        this.faceEngine.cropFaceAvatar(cluster.avatarUrl, cluster.box).then((cropped) => {
          if (cropped && cropped.startsWith('data:')) {
            cluster.avatarUrl = cropped;
            const img = card.querySelector('.cluster-avatar');
            if (img) img.src = cropped;
            this.saveFaceClustersToStorage();
          }
        });
      }

      // Đổi tên nhân vật (VD: Cô dâu, Chú rể)
      const labelEl = card.querySelector('.cluster-label');
      labelEl?.addEventListener('click', (e) => {
        e.stopPropagation();
        const newName = prompt(`Nhập tên mới cho nhóm khuôn mặt này (Ví dụ: Cô dâu, Chú rể...):`, cluster.label.replace(' ✏️', ''));
        if (newName && newName.trim()) {
          cluster.label = newName.trim();
          this.saveFaceClustersToStorage();
          this.renderFaceClustersGrid();
          this.renderPeopleBar();
        }
      });

      card.addEventListener('click', () => {
        this.applyClusterFilter(cluster);
      });
      this.faceClustersGrid.appendChild(card);
    }
  }

  applyClusterFilter(cluster) {
    this.selectedClusterId = cluster.id;
    const scores = new Map();
    for (const pid of cluster.photoIds) {
      scores.set(pid, 0.99);
    }
    this.faceScoresMap = scores;
    this.activeFaceFilter = {
      targetEmbedding: cluster.representativeEmbedding,
      avatarUrl: cluster.avatarUrl,
      scores,
      threshold: 0.5,
      label: cluster.label,
    };

    this.faceBannerAvatar.src = cluster.avatarUrl;
    this.faceActiveBanner.classList.remove('hidden');
    this.renderPeopleBar();
    this.closeFaceModal();
    this.applyFilters();
    this.showToast(`Đang lọc ảnh của ${cluster.label} (${cluster.photoCount} ảnh)`, 'success');
  }

  renderFacePickerGrid() {
    this.facePickerGrid.innerHTML = '';
    const sampleList = this.allPhotos.slice(0, 48); // Lấy 48 ảnh đầu để chọn nhanh
    for (const photo of sampleList) {
      const item = document.createElement('div');
      item.className = 'face-picker-item';
      item.innerHTML = `
        <img src="${photo.aiUrl}" loading="lazy" alt="${photo.name}">
        <span class="face-picker-name">${photo.name}</span>
      `;
      item.addEventListener('click', () => {
        this.startFaceDetectionWithSample(photo);
      });
      this.facePickerGrid.appendChild(item);
    }
  }

  async startFaceDetectionWithSample(photo) {
    this.showFaceStep('scan');
    this.faceScanStatusTitle.textContent = 'Đang phát hiện khuôn mặt trong ảnh mẫu...';
    this.faceScanProgressFill.style.width = '20%';

    try {
      const faces = await this.faceEngine.detectFacesInImage(photo.aiUrl);

      if (faces.length === 0) {
        alert('Không tìm thấy khuôn mặt nào trong bức ảnh này. Vui lòng chọn ảnh khác rõ mặt hơn!');
        this.showFaceStep('pick');
        return;
      }

      if (faces.length === 1) {
        // Chỉ có 1 người, quét tìm luôn
        await this.runFaceScan(photo, faces[0].embedding, photo.aiUrl);
      } else {
        // Nhiều người: Hiển thị giao diện chạm chọn người cụ thể
        this.showFaceStep('select');
        this.setupFaceBoxesOverlay(photo, faces);
      }
    } catch (err) {
      console.error(err);
      alert('Lỗi nạp mô hình nhận diện khuôn mặt: ' + err.message);
      this.closeFaceModal();
    }
  }

  setupFaceBoxesOverlay(photo, faces) {
    this.faceSampleImg.src = photo.aiUrl;
    this.faceBoxesOverlay.innerHTML = '';

    this.faceSampleImg.onload = () => {
      const displayW = this.faceSampleImg.clientWidth;
      const displayH = this.faceSampleImg.clientHeight;
      const naturalW = this.faceSampleImg.naturalWidth;
      const naturalH = this.faceSampleImg.naturalHeight;

      const scaleX = displayW / naturalW;
      const scaleY = displayH / naturalH;

      faces.forEach((face, idx) => {
        const [x, y, w, h] = face.box;
        const boxBtn = document.createElement('button');
        boxBtn.type = 'button';
        boxBtn.className = 'face-box-btn';
        boxBtn.style.left = `${x * scaleX}px`;
        boxBtn.style.top = `${y * scaleY}px`;
        boxBtn.style.width = `${w * scaleX}px`;
        boxBtn.style.height = `${h * scaleY}px`;
        boxBtn.innerHTML = `<span class="face-box-tag">Người ${idx + 1}</span>`;

        boxBtn.addEventListener('click', () => {
          this.runFaceScan(photo, face.embedding, photo.aiUrl);
        });

        this.faceBoxesOverlay.appendChild(boxBtn);
      });
    };
  }

  async runFaceScan(samplePhoto, embedding, avatarUrl) {
    this.showFaceStep('scan');
    this.isScanningFace = true;
    const totalPhotos = this.allPhotos ? this.allPhotos.length : 0;
    this.updateFaceScanUI({
      percent: 0,
      statusTitle: 'Đang quét tìm kiếm theo khuôn mặt...',
      statusDesc: 'Khởi động AI so khớp đặc trưng khuôn mặt mục tiêu...',
      badge: 'Tìm kiếm',
      badgeType: 'active',
      scanned: 0,
      total: totalPhotos,
      faces: 1,
      clusters: 1,
    });

    try {
      const scores = await this.faceEngine.scanAlbumForFace(
        this.allPhotos,
        embedding,
        (p) => {
          const total = p.total || totalPhotos || 1;
          const current = p.current || 0;
          const pct = Math.min(100, Math.round((current / total) * 100));
          const matches = p.matchesCount || 0;

          if (p.phase === 'init_model') {
            this.updateFaceScanUI({
              percent: 5,
              statusTitle: 'Đang nạp mô hình AI...',
              statusDesc: 'Chuẩn bị mô hình nhận diện khuôn mặt...',
              badge: 'Nạp Model',
              badgeType: 'warning',
              scanned: 0,
              total,
              faces: 1,
              clusters: 1,
            });
          } else {
            this.updateFaceScanUI({
              percent: pct,
              statusTitle: 'Đang so khớp khuôn mặt trên từng ảnh...',
              statusDesc: `Đã tìm thấy ${matches} ảnh khớp (${current}/${total} ảnh)...`,
              badge: `Khớp ${matches} ảnh`,
              badgeType: 'active',
              scanned: current,
              total,
              faces: matches,
              clusters: 1,
            });
          }
        }
      );

      this.faceScoresMap = scores;
      this.isScanningFace = false;
      const defaultThreshold = STUDIO_CONFIG.faceAI.defaultThreshold || 0.52;
      this.activeFaceFilter = {
        targetEmbedding: embedding,
        avatarUrl,
        scores,
        threshold: defaultThreshold,
      };

      this.faceBannerAvatar.src = avatarUrl;
      this.faceThresholdSlider.value = defaultThreshold;
      this.faceThresholdVal.textContent = `${Math.round(defaultThreshold * 100)}%`;
      this.faceActiveBanner.classList.remove('hidden');

      this.closeFaceModal();
      this.applyFilters();
      this.showToast('Đã quét xong và lọc album theo khuôn mặt đã chọn!', 'success');
    } catch (err) {
      this.isScanningFace = false;
      console.error(err);
      alert('Quá trình quét khuôn mặt gặp lỗi: ' + err.message);
      this.closeFaceModal();
    }
  }

  clearFaceFilter() {
    this.activeFaceFilter = null;
    this.selectedClusterId = null;
    this.faceScoresMap.clear();
    this.faceActiveBanner.classList.add('hidden');
    this.renderPeopleBar();
    this.applyFilters();
  }

  // --- Submit & Export Modal ---
  initSubmitModal() {
    this.submitModal = document.getElementById('submit-modal');
    this.kpiSelectedVal = document.getElementById('kpi-selected-val');
    this.kpiPriorityVal = document.getElementById('kpi-priority-val');
    this.kpiLimitVal = document.getElementById('kpi-limit-val');
    this.kpiExtraBox = document.getElementById('kpi-extra-box');
    this.kpiExtraVal = document.getElementById('kpi-extra-val');

    this.exportToggleExt = document.getElementById('export-toggle-ext');
    this.exportC1Textarea = document.getElementById('export-c1-textarea');
    this.btnCopyC1 = document.getElementById('btn-copy-c1-string');
    this.orderDetailsList = document.getElementById('order-details-list');

    this.btnConfirmSendOrder = document.getElementById('btn-confirm-send-order');
    this.btnDownloadReportTxt = document.getElementById('btn-download-report-txt');
    this.submitSuccessBanner = document.getElementById('submit-success-banner');

    document.getElementById('btn-open-submit-modal').addEventListener('click', () => {
      this.openSubmitModal();
    });

    document.getElementById('submit-modal-close').addEventListener('click', () => {
      this.closeSubmitModal();
    });

    this.exportToggleExt.addEventListener('change', () => {
      this.updateC1ExportString();
    });

    this.btnCopyC1.addEventListener('click', () => {
      navigator.clipboard.writeText(this.exportC1Textarea.value);
      this.btnCopyC1.textContent = 'Đã chép!';
      setTimeout(() => (this.btnCopyC1.textContent = 'Sao chép'), 1600);
    });

    this.btnConfirmSendOrder.addEventListener('click', () => {
      this.submitOrder();
    });

    this.btnDownloadReportTxt.addEventListener('click', () => {
      const payload = this.buildCurrentOrderPayload();
      ExportService.downloadReportFile(payload);
    });

    document.getElementById('btn-download-selected-zip')?.addEventListener('click', () => {
      this.downloadSelectedDirect();
    });

    document.getElementById('btn-download-all-zip')?.addEventListener('click', () => {
      this.downloadAllDirect();
    });

    document.getElementById('bar-btn-download-menu')?.addEventListener('click', () => {
      const selectedPhotos = this.allPhotos.filter((p) => this.getPhotoSelection(p.id).selected);
      if (selectedPhotos.length > 0) {
        this.downloadMultiplePhotosDirect(selectedPhotos, 'ảnh đã chọn');
      } else {
        this.showToast('Bạn chưa chọn ảnh nào! Hãy bấm tim ♥ vào các ảnh bạn thích để tải nhé.', 'info');
      }
    });
  }

  buildCurrentOrderPayload() {
    const selectedPhotos = this.allPhotos.filter((p) => this.getPhotoSelection(p.id).selected);
    const priorityPhotos = this.allPhotos.filter((p) => this.getPhotoSelection(p.id).priority);

    return ExportService.buildOrderPayload({
      clientName: this.clientName,
      packageName: this.packageName,
      limit: this.limit,
      folderId: this.folderId || 'demo',
      selectedPhotos,
      priorityPhotos,
      allPhotos: this.allPhotos,
      selectionsMap: this.selectionsMap,
    });
  }

  openSubmitModal() {
    const payload = this.buildCurrentOrderPayload();
    if (payload.selectedCount === 0) {
      alert('Bạn chưa chọn bức ảnh nào. Vui lòng bấm vào hình trái tim ♥ để chọn ảnh trước khi gửi danh sách nhé!');
      return;
    }

    this.submitSuccessBanner.classList.add('hidden');
    this.kpiSelectedVal.textContent = payload.selectedCount;
    this.kpiPriorityVal.textContent = payload.priorityCount;
    this.kpiLimitVal.textContent = payload.limit > 0 ? `${payload.limit} ảnh` : 'Không giới hạn';

    const extraFeeAlert = document.getElementById('extra-fee-alert');
    const extraFeeCount = document.getElementById('extra-fee-count');
    const extraFeeTotal = document.getElementById('extra-fee-total');

    if (payload.overLimit > 0) {
      const extraFee = payload.overLimit * 25000;
      this.kpiExtraVal.textContent = `+${payload.overLimit} ảnh`;
      this.kpiExtraBox.classList.remove('hidden');
      if (extraFeeAlert) extraFeeAlert.classList.remove('hidden');
      if (extraFeeCount) extraFeeCount.textContent = `${payload.overLimit}`;
      if (extraFeeTotal) extraFeeTotal.textContent = `+${extraFee.toLocaleString('vi-VN')} VNĐ`;
    } else {
      this.kpiExtraBox.classList.add('hidden');
      if (extraFeeAlert) extraFeeAlert.classList.add('hidden');
    }

    this.updateC1ExportString();
    this.renderOrderDetails(payload);

    this.submitModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  closeSubmitModal() {
    this.submitModal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  updateC1ExportString() {
    const payload = this.buildCurrentOrderPayload();
    const withExt = this.exportToggleExt.checked;
    this.exportC1Textarea.value = withExt ? payload.c1StringWithExt : payload.c1StringNoExt;
  }

  renderOrderDetails(payload) {
    this.orderDetailsList.innerHTML = '';
    for (const item of payload.items) {
      const row = document.createElement('div');
      row.className = 'detail-row';
      const tagStr = item.tags.length ? `[${item.tags.join(', ')}] ` : '';
      const noteStr = item.note || '';

      row.innerHTML = `
        <span class="detail-file">${item.isPriority ? '★ ' : '♥ '}${item.filename}</span>
        <span class="detail-notes">${tagStr}${noteStr}</span>
      `;
      this.orderDetailsList.appendChild(row);
    }
  }

  async submitOrder() {
    const payload = this.buildCurrentOrderPayload();
    this.btnConfirmSendOrder.disabled = true;
    this.btnConfirmSendOrder.textContent = 'Đang chuyển dữ liệu...';

    // 1. Gửi Webhook Google Sheets
    await ExportService.submitToGoogleSheets(payload);

    // 2. Gửi Telegram nếu có cấu hình
    const teleRes = await ExportService.sendTelegramNotification(payload);

    this.btnConfirmSendOrder.disabled = false;
    this.btnConfirmSendOrder.textContent = 'Gửi lại đơn';
    this.submitSuccessBanner.classList.remove('hidden');

    if (teleRes && teleRes.success) {
      this.showToast('✅ Đã gửi đơn và thông báo tới Telegram @locanh_bot thành công!', 'success');
    } else {
      this.showToast('Gửi danh sách thành công tới Studio!', 'success');
    }
  }

  // --- Quản Trị (#admin) ---
  initAdmin() {
    this.adminManager = new AdminManager(this.adminView);
    this.updateAdminHeaderState();
  }

  // --- Modal Dán Link Google Drive Nhanh ---
  initQuickDriveModal() {
    const modal = document.getElementById('quick-drive-modal');
    const input = document.getElementById('quick-drive-input');
    const badge = document.getElementById('quick-folder-badge');
    const clientInput = document.getElementById('quick-client-name');
    const packageInput = document.getElementById('quick-package-name');
    const limitInput = document.getElementById('quick-limit-input');
    const btnSubmit = document.getElementById('quick-drive-submit');
    const btnCancel = document.getElementById('quick-drive-cancel');
    const btnClose = document.getElementById('quick-drive-close');
    const quickToAdmin = document.getElementById('quick-to-admin-link');

    const openModal = () => {
      input.value = this.folderId || '';
      clientInput.value = this.clientName === 'Khách hàng' ? '' : this.clientName;
      packageInput.value = this.packageName === 'Album Tiêu Chuẩn' ? '' : this.packageName;
      limitInput.value = this.limit > 0 ? this.limit : '';
      checkInput();
      modal.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
      setTimeout(() => input.focus(), 80);
    };

    const closeModal = () => {
      modal.classList.add('hidden');
      document.body.style.overflow = '';
    };

    const checkInput = () => {
      const folderId = extractDriveFolderId(input.value);
      if (folderId) {
        badge.textContent = `ID: ${folderId}`;
        badge.className = 'extracted-badge is-ok';
        badge.classList.remove('hidden');
      } else if (input.value.trim()) {
        badge.textContent = 'Chưa đúng định dạng';
        badge.className = 'extracted-badge is-err';
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    };

    input.addEventListener('input', checkInput);

    // Mở từ Header button hoặc Trigger buttons
    document.getElementById('btn-quick-open-drive')?.addEventListener('click', openModal);
    document.querySelectorAll('.btn-open-quick-drive-trigger').forEach((btn) => {
      btn.addEventListener('click', openModal);
    });

    btnClose?.addEventListener('click', closeModal);
    btnCancel?.addEventListener('click', closeModal);
    quickToAdmin?.addEventListener('click', closeModal);

    btnSubmit?.addEventListener('click', () => {
      const folderId = extractDriveFolderId(input.value);
      if (!folderId) {
        alert('Vui lòng dán link Google Drive hoặc nhập ID thư mục hợp lệ!');
        input.focus();
        return;
      }

      const client = clientInput.value.trim() || 'Khách hàng';
      const pkg = packageInput.value.trim() || 'Album Tiêu Chuẩn';
      const limit = parseInt(limitInput.value, 10) || 0;

      const params = new URLSearchParams(window.location.search);
      params.set('folder', folderId);
      params.set('khach', client);
      params.set('goi', pkg);
      if (limit > 0) {
        params.set('limit', limit);
      } else {
        params.delete('limit');
      }

      closeModal();
      window.location.search = params.toString();
    });
  }

  // --- Modal Đồng Bộ Đa Thiết Bị & Chia Sẻ ---
  initSyncModal() {
    const modal = document.getElementById('sync-modal');
    const btnClose = document.getElementById('sync-modal-close');
    const btnNow = document.getElementById('sync-modal-btn-now');
    const btnCopyLink = document.getElementById('sync-modal-btn-copy-link');
    const btnImport = document.getElementById('sync-modal-btn-import');
    const importText = document.getElementById('sync-modal-import-text');

    const openModal = () => {
      modal.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
      this.syncCloudNow(false);
    };

    const closeModal = () => {
      modal.classList.add('hidden');
      document.body.style.overflow = '';
    };

    this.btnCloudSync?.addEventListener('click', openModal);
    btnClose?.addEventListener('click', closeModal);

    btnNow?.addEventListener('click', () => {
      this.syncCloudNow(true);
    });

    btnCopyLink?.addEventListener('click', () => {
      this.copyShareableLinkWithSelections();
    });

    btnImport?.addEventListener('click', () => {
      const val = importText.value.trim();
      if (!val) {
        alert('Vui lòng dán danh sách tên file ảnh!');
        return;
      }
      this.applySelectedFromParam(val);
      closeModal();
      importText.value = '';
    });
  }

  applySelectedFromParam(paramStr) {
    if (!paramStr) return;
    const tokens = new Set(
      paramStr
        .split(/[,;\s\n\r]+/)
        .map((s) => s.trim().toLowerCase().replace(/\.[a-z0-9]+$/i, ''))
        .filter(Boolean)
    );
    let matchedCount = 0;
    for (const p of this.allPhotos) {
      const bName = (p.baseName || '').toLowerCase();
      const pName = (p.name || '').toLowerCase();
      if (tokens.has(bName) || tokens.has(pName) || tokens.has(p.id.toLowerCase())) {
        const cur = this.getPhotoSelection(p.id);
        cur.selected = true;
        this.selectionsMap.set(p.id, { ...cur, updatedAt: Date.now() });
        this.galleryGrid?.updateCardState(p.id, cur);
        matchedCount++;
      }
    }
    if (matchedCount > 0) {
      StorageManager.saveDraft(this.folderId || 'demo', this.selectionsMap);
      this.updateCounters();
      this.showToast(`✨ Đã nhận diện và chọn ${matchedCount} ảnh!`);
    } else {
      this.showToast('Không tìm thấy ảnh nào khớp với danh sách đã nhập.');
    }
  }

  copyShareableLinkWithSelections() {
    const selectedPhotos = this.allPhotos.filter((p) => this.getPhotoSelection(p.id).selected);
    if (selectedPhotos.length === 0) {
      this.showToast('Bạn chưa chọn ảnh nào trên thiết bị này.');
      return;
    }
    const selStr = selectedPhotos.map((p) => p.baseName).join(',');
    const url = new URL(window.location.href);
    url.searchParams.set('sel', selStr);
    
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url.toString()).then(() => {
        this.showToast(`📋 Đã sao chép link kèm ${selectedPhotos.length} ảnh đã chọn! Gửi sang máy tính mở là có ngay.`);
      }).catch(() => {
        prompt('Sao chép liên kết này gửi sang máy tính:', url.toString());
      });
    } else {
      prompt('Sao chép liên kết này gửi sang máy tính:', url.toString());
    }
  }

  // --- Tải Ảnh Gốc 100% Nguyên Bản (20MB) & Lưu Vào Thư Viện Không Rời Trang ---
  async downloadOriginalFile(photo) {
    if (!photo) return;
    const fileName = photo.name && (photo.name.toLowerCase().endsWith('.jpg') || photo.name.toLowerCase().endsWith('.jpeg') || photo.name.toLowerCase().endsWith('.png'))
      ? photo.name
      : `${photo.name || photo.id}.jpg`;

    this.showToast(`⏳ Đang nạp ảnh gốc ${fileName} (~20MB)...`, 'info', 4000);

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    try {
      const directUrl = photo.originalUrl || `https://lh3.googleusercontent.com/d/${photo.id}=s0`;
      const res = await fetch(directUrl);
      if (res.ok) {
        const originalBlob = await res.blob();

        // 1. Trên iOS / iPhone: Gọi native iOS Share Sheet để người dùng bấm ngay "Lưu hình ảnh" vào Cuộn camera
        if (isIOS && navigator.canShare && typeof File === 'function') {
          try {
            const file = new File([originalBlob], fileName, { type: 'image/jpeg' });
            if (navigator.canShare({ files: [file] })) {
              await navigator.share({
                files: [file],
                title: fileName,
              });
              this.showToast(`✅ Đã lưu ảnh ${fileName} vào Thư viện Ảnh!`, 'success');
              return;
            }
          } catch (shareErr) {
            if (shareErr.name === 'AbortError') return; // Người dùng chủ động ấn Hủy menu share
            console.warn('Share API error, fallback to blob download:', shareErr);
          }
        }

        // 2. Trên Android, Máy tính hoặc khi không dùng Share Sheet:
        // Tải qua Same-Origin Blob URL (trình duyệt tải ngay trong nền, TUYỆT ĐỐI KHÔNG mở tab mới, không rời trang)
        const downloadBlob = new Blob([originalBlob], { type: 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(downloadBlob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fileName;
        // TUYỆT ĐỐI KHÔNG dùng target="_blank" để tránh bị Safari nhảy tab/thoát trang
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(blobUrl);
        }, 4000);
        this.showToast(`✅ Đã tải file gốc ${fileName}!`, 'success');
        return;
      }
    } catch (err) {
      console.warn('Blob fetch error, fallback to direct drive:', err);
    }

    // Fallback nếu không fetch được blob: Tải trực tiếp nhưng KHÔNG dùng target="_blank"
    const directDownloadUrl = `https://drive.usercontent.google.com/download?id=${photo.id}&export=download&authuser=0`;
    const a = document.createElement('a');
    a.href = directDownloadUrl;
    a.download = fileName;
    // Không dùng target="_blank"
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 2000);
    this.showToast(`✅ Đang tải ${fileName}...`, 'success');
  }

  async saveToCameraRoll(photo) {
    if (!photo) return;
    await this.downloadOriginalFile(photo);
  }

  downloadSinglePhoto(photo) {
    this.downloadOriginalFile(photo);
  }

  async downloadMultiplePhotosDirect(photoList, label = 'ảnh đã chọn') {
    if (!photoList || photoList.length === 0) {
      alert(`Chưa có ${label} nào để tải!`);
      return;
    }

    // Tối ưu lưu cả chùm ảnh thẳng vào Thư viện iPhone (Photos) qua menu iOS nếu danh sách <= 15 ảnh
    if (navigator.canShare && typeof File === 'function' && photoList.length <= 15) {
      this.showToast(`Đang chuẩn bị ${photoList.length} ảnh để lưu vào Thư viện ảnh...`, 'info');
      try {
        const fileList = [];
        for (const p of photoList) {
          const directUrl = p.originalUrl || `https://lh3.googleusercontent.com/d/${p.id}=s0`;
          const res = await fetch(directUrl);
          if (res.ok) {
            const b = await res.blob();
            const fName = p.name && (p.name.toLowerCase().endsWith('.jpg') || p.name.toLowerCase().endsWith('.jpeg')) ? p.name : `${p.name || p.id}.jpg`;
            fileList.push(new File([b], fName, { type: 'image/jpeg' }));
          }
        }

        if (fileList.length > 0 && navigator.canShare({ files: fileList })) {
          await navigator.share({
            files: fileList,
            title: `Bộ ${fileList.length} ảnh ${this.clientName}`,
          });
          this.showToast(`✅ Bấm "Lưu ${fileList.length} hình ảnh" để lưu toàn bộ vào Thư viện ảnh!`, 'success');
          return;
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.warn('Lỗi share chùm ảnh trên iOS:', err);
      }
    }

    if (photoList.length > 25) {
      if (!confirm(`Bạn đang chuẩn bị tải trực tiếp ${photoList.length} file ảnh JPG về máy. Tiếp tục?`)) {
        return;
      }
    }

    this.showToast(`Bắt đầu tải trực tiếp ${photoList.length} file ảnh JPG...`, 'info');
    let loadedCount = 0;

    for (const photo of photoList) {
      loadedCount++;
      const fileName = photo.name && (photo.name.toLowerCase().endsWith('.jpg') || photo.name.toLowerCase().endsWith('.jpeg') || photo.name.toLowerCase().endsWith('.png'))
        ? photo.name
        : `${photo.name || photo.id}.jpg`;

      this.showToast(`Đang tải JPG (${loadedCount}/${photoList.length}): ${fileName}...`, 'info');

      try {
        const directUrl = photo.originalUrl || `https://lh3.googleusercontent.com/d/${photo.id}=s0`;
        const res = await fetch(directUrl);
        if (res.ok) {
          const originalBlob = await res.blob();
          const downloadBlob = new Blob([originalBlob], { type: 'application/octet-stream' });
          const blobUrl = URL.createObjectURL(downloadBlob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
          }, 2000);
        }
      } catch (err) {
        console.warn(`Lỗi khi tải file ${fileName}:`, err);
      }

      if (loadedCount < photoList.length) {
        // Nghỉ 400ms giữa các ảnh để trình duyệt tải tuần tự từng file JPG không bị chặn popup
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    this.showToast(`✅ Đã tải xong ${photoList.length} ảnh JPG về máy!`, 'success');
  }

  async downloadSelectedDirect() {
    const selectedPhotos = this.allPhotos.filter((p) => this.getPhotoSelection(p.id).selected);
    if (selectedPhotos.length === 0) {
      alert('Bạn chưa chọn bức ảnh nào để tải! Hãy thả tim ♥ ảnh bạn muốn tải trước nhé.');
      return;
    }
    await this.downloadMultiplePhotosDirect(selectedPhotos, 'ảnh đã chọn');
  }

  async downloadAllDirect() {
    if (!this.allPhotos || this.allPhotos.length === 0) {
      alert('Không có ảnh nào trong album để tải!');
      return;
    }
    if (!confirm(`Bạn có muốn tải trực tiếp toàn bộ ${this.allPhotos.length} ảnh JPG của album này về máy?`)) return;
    await this.downloadMultiplePhotosDirect(this.allPhotos, 'toàn bộ album');
  }

  // --- Menu Ngữ Cảnh Khi Ấn Giữ Ảnh (Long-press) ---
  initPhotoContextMenu() {
    this.contextMenu = document.getElementById('photo-context-menu');
    this.ctxThumb = document.getElementById('ctx-photo-thumb');
    this.ctxName = document.getElementById('ctx-photo-name');
    this.ctxMeta = document.getElementById('ctx-photo-meta');
    this.ctxBtnClose = document.getElementById('ctx-btn-close');
    this.ctxBackdrop = document.getElementById('ctx-backdrop');
    this.ctxBtnSelect = document.getElementById('ctx-btn-select');
    this.ctxSelectText = document.getElementById('ctx-select-text');
    this.ctxHeartIcon = document.getElementById('ctx-heart-icon');
    this.ctxBtnPriority = document.getElementById('ctx-btn-priority');
    this.ctxPriorityText = document.getElementById('ctx-priority-text');
    this.ctxStarIcon = document.getElementById('ctx-star-icon');
    this.ctxBtnNote = document.getElementById('ctx-btn-note');
    this.ctxBtnDownload = document.getElementById('ctx-btn-download');

    const closeMenu = () => {
      this.contextMenu?.classList.add('hidden');
      this.activeContextPhoto = null;
    };

    this.ctxBtnClose?.addEventListener('click', closeMenu);
    this.ctxBackdrop?.addEventListener('click', closeMenu);

    this.ctxBtnSelect?.addEventListener('click', () => {
      if (this.activeContextPhoto) {
        this.toggleHeart(this.activeContextPhoto.id);
        closeMenu();
      }
    });

    this.ctxBtnPriority?.addEventListener('click', () => {
      if (this.activeContextPhoto) {
        this.toggleStar(this.activeContextPhoto.id);
        closeMenu();
      }
    });

    this.ctxBtnNote?.addEventListener('click', () => {
      if (this.activeContextPhoto) {
        const idx = this.filteredPhotos.indexOf(this.activeContextPhoto);
        closeMenu();
        this.openLightboxAt(idx >= 0 ? idx : 0, true);
      }
    });

    this.ctxBtnDownload?.addEventListener('click', () => {
      if (this.activeContextPhoto) {
        const p = this.activeContextPhoto;
        closeMenu();
        this.downloadOriginalFile(p);
      }
    });

    document.getElementById('ctx-btn-share-photos')?.addEventListener('click', () => {
      if (this.activeContextPhoto) {
        const p = this.activeContextPhoto;
        closeMenu();
        this.saveToCameraRoll(p);
      }
    });
  }

  openPhotoContextMenu(photo, index) {
    if (!photo || !this.contextMenu) return;
    this.activeContextPhoto = photo;
    const sel = this.getPhotoSelection(photo.id);

    if (this.ctxThumb) this.ctxThumb.src = photo.gridUrl || photo.thumbUrl;
    if (this.ctxName) this.ctxName.textContent = photo.name;
    if (this.ctxMeta) {
      this.ctxMeta.textContent = `${photo.folderName || 'Ảnh chung'} • ${sel.selected ? 'Đã chọn ♥' : 'Chưa chọn'}`;
    }

    if (this.ctxSelectText) {
      this.ctxSelectText.textContent = sel.selected ? 'Bỏ chọn ảnh này' : 'Chọn bức ảnh này';
    }
    if (this.ctxHeartIcon) {
      this.ctxHeartIcon.textContent = sel.selected ? '💔' : '❤️';
    }

    if (this.ctxPriorityText) {
      this.ctxPriorityText.textContent = sel.priority ? 'Bỏ đánh dấu ưu tiên' : 'Đánh dấu ưu tiên / In phóng';
    }
    if (this.ctxStarIcon) {
      this.ctxStarIcon.textContent = sel.priority ? '⭐' : '☆';
    }

    this.contextMenu.classList.remove('hidden');
  }

  // --- Chụp Mặt Selfie Nhận Diện Tức Thì Cho Khách Sự Kiện ---
  initSelfieCapture() {
    this.faceSelfieInput = document.getElementById('face-selfie-input');
    this.btnTriggerSelfie = document.getElementById('btn-trigger-selfie-scan');
    this.btnPeopleSelfie = document.getElementById('btn-people-selfie');

    const triggerCapture = () => {
      this.faceSelfieInput?.click();
    };

    this.btnTriggerSelfie?.addEventListener('click', triggerCapture);
    this.btnPeopleSelfie?.addEventListener('click', triggerCapture);

    this.faceSelfieInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      this.faceSelfieInput.value = '';
      await this.handleSelfieFaceSearch(file);
    });
  }

  async handleSelfieFaceSearch(file) {
    this.openFaceModal();
    this.showFaceStep('scan');
    this.isScanningFace = true;
    const totalPhotos = this.allPhotos ? this.allPhotos.length : 0;
    this.updateFaceScanUI({
      percent: 15,
      statusTitle: 'Đang nhận diện khuôn mặt bạn từ ảnh selfie...',
      statusDesc: 'AI đang trích xuất đặc trưng khuôn mặt của bạn...',
      badge: 'Chụp Selfie',
      badgeType: 'warning',
      scanned: 0,
      total: totalPhotos,
      faces: 1,
      clusters: 1,
    });

    try {
      const imgUrl = URL.createObjectURL(file);
      const imgEl = new Image();
      imgEl.src = imgUrl;
      await new Promise((res, rej) => {
        imgEl.onload = res;
        imgEl.onerror = () => rej(new Error('Không thể tải ảnh selfie vừa chụp'));
      });

      const faces = await this.faceEngine.detectFacesInImage(imgEl);
      if (!faces || faces.length === 0) {
        alert('Không phát hiện thấy khuôn mặt rõ nét trong ảnh chụp. Vui lòng chụp lại ảnh khuôn mặt chính diện, đủ sáng nhé!');
        this.showFaceStep('clusters');
        return;
      }

      this.updateFaceScanUI({
        percent: 40,
        statusTitle: 'Đã nhận diện khuôn mặt bạn!',
        statusDesc: 'Đang chuẩn bị so khớp với toàn bộ album...',
        badge: 'Đã nhận diện',
        badgeType: 'active',
        scanned: 0,
        total: totalPhotos,
        faces: 1,
        clusters: 1,
      });

      const face = faces[0];

      // Cắt ảnh avatar khuôn mặt selfie
      const avatarCanvas = document.createElement('canvas');
      avatarCanvas.width = 120;
      avatarCanvas.height = 120;
      const ctx = avatarCanvas.getContext('2d');
      const [x, y, w, h] = face.box;
      ctx.drawImage(imgEl, x, y, w, h, 0, 0, 120, 120);
      const avatarDataUrl = avatarCanvas.toDataURL('image/jpeg', 0.85);

      const scores = await this.faceEngine.scanAlbumForFace(this.allPhotos, face.embedding, (p) => {
        const total = p.total || totalPhotos || 1;
        const current = p.current || 0;
        const pct = Math.min(100, Math.round(40 + (current / total) * 60));
        const matches = p.matchesCount || 0;
        this.updateFaceScanUI({
          percent: pct,
          statusTitle: 'Đang tìm ảnh có khuôn mặt bạn...',
          statusDesc: `Đã tìm thấy ${matches} ảnh có mặt bạn (${current}/${total} ảnh)...`,
          badge: `Tìm thấy ${matches} ảnh`,
          badgeType: 'active',
          scanned: current,
          total,
          faces: matches,
          clusters: 1,
        });
      });

      this.faceScoresMap = scores;
      const defaultThreshold = STUDIO_CONFIG.faceAI.defaultThreshold || 0.52;
      this.activeFaceFilter = {
        targetEmbedding: face.embedding,
        avatarUrl: avatarDataUrl,
        scores,
        threshold: defaultThreshold,
      };

      this.faceBannerAvatar.src = avatarDataUrl;
      this.faceThresholdSlider.value = defaultThreshold;
      this.faceThresholdVal.textContent = `${Math.round(defaultThreshold * 100)}%`;
      this.faceActiveBanner.classList.remove('hidden');

      this.closeFaceModal();
      this.applyFilters();

      const matchCount = Array.from(scores.values()).filter((s) => s >= defaultThreshold).length;
      this.showToast(`🎉 Đã nhận diện khuôn mặt bạn và tìm thấy ${matchCount} ảnh!`, 'success');
      URL.revokeObjectURL(imgUrl);
    } catch (err) {
      console.error('Lỗi nhận diện selfie:', err);
      alert('Lỗi nhận diện khuôn mặt: ' + err.message);
      this.showFaceStep('clusters');
    }
  }

  // --- Toast thông báo ---
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-8px)';
      toast.style.transition = 'all 0.2s';
      setTimeout(() => toast.remove(), 250);
    }, 2800);
  }
}

// Khởi động ứng dụng ngay khi DOM sẵn sàng hoặc nếu đã sẵn sàng từ trước
function startStudioApp() {
  if (!window.__studioApp) {
    window.__studioApp = new AppController();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startStudioApp);
} else {
  startStudioApp();
}
