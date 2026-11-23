/**
 * Module điều phối chính của ứng dụng Studio Photo Selector
 */
import { STUDIO_CONFIG } from '../config.js?v=8.3';
import { loadDriveAlbum, loadDemoAlbum, stripExtension, extractDriveFolderId, clearAlbumCache } from './drive.js?v=8.3';
import { GalleryGrid } from './gallery.js?v=8.3';
import { LightboxModal } from './lightbox.js?v=8.3';
import { StorageManager } from './storage.js?v=8.3';
import { FaceFilterEngine } from './face-filter.js?v=8.3';
import { ExportService } from './export.js?v=8.3';
import { AdminManager } from './admin.js?v=8.3';

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

      window.addEventListener('hashchange', () => this.handleRoute());
      this.handleRoute();

      await this.loadAlbumData();
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
        const normKey = shortKey.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        const matched = history.find((h) => {
          const s = (h.slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const c = (h.client || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          return s === normKey || c === normKey;
        });
        if (matched) {
          folder = matched.folderId;
          client = matched.client;
          pkg = matched.pkg;
          limit = matched.limit || 0;
          download = matched.download === 1;
        }
      } catch (e) {
        // ignore
      }
    }

    // Nếu tên khách lấy từ slug k (ví dụ: doi-cuoi-tu-son-21), hiển thị đẹp mắt
    if (client && !params.get('khach') && params.get('k')) {
      client = client.replace(/[-_]+/g, ' ');
    }

    this.folderId = folder;
    this.clientName = client || 'Khách hàng';
    this.packageName = pkg || 'Album Tiêu Chuẩn';
    this.limit = limit;
    this.allowDownload = download;
    this.initialSelParam = params.get('sel') || '';

    // Đọc nháp lưu từ trước nếu có
    const draft = StorageManager.loadDraft(this.folderId || 'demo');
    for (const [id, val] of Object.entries(draft)) {
      this.selectionsMap.set(id, val);
    }
  }

  bindDOM() {
    this.siteHeader = document.getElementById('site-header');
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

    // Bấm vào chỗ số lượng ảnh để chỉnh sửa định mức ảnh (CHỈ ADMIN MỚI ĐƯỢC PHÉP SỬA)
    const headerLimitPill = document.getElementById('header-limit-pill');
    this.headerLimitPill = headerLimitPill;
    this.headerLimitEditIcon = document.getElementById('header-limit-edit-icon');
    this.adminNavBtn = document.getElementById('btn-to-admin');
    this.adminNavIcon = document.getElementById('admin-nav-icon');
    this.adminNavText = document.getElementById('admin-nav-text');

    headerLimitPill?.addEventListener('click', () => {
      const isAuth = Boolean(this.adminManager?.isLoggedIn());
      if (!isAuth) {
        if (confirm('Chỉ Quản trị viên Studio mới có quyền cài đặt định mức số lượng ảnh chọn của album này. Bạn có muốn chuyển sang trang Đăng nhập Quản trị không?')) {
          window.location.hash = '#admin';
        }
        return;
      }
      const currentVal = this.limit > 0 ? this.limit : '';
      const input = prompt('Nhập số lượng ảnh khách cần chọn (Ví dụ: 30, hoặc để trống = Không giới hạn):', currentVal);
      if (input !== null) {
        const parsed = parseInt(input.trim(), 10);
        this.limit = (!isNaN(parsed) && parsed > 0) ? parsed : 0;
        if (this.headerLimitCount) this.headerLimitCount.textContent = this.limit > 0 ? `${this.limit} ảnh` : 'Không giới hạn';
        if (this.counterLimit) this.counterLimit.textContent = this.limit > 0 ? `${this.limit}` : '∞';
        this.updateCounters();

        const url = new URL(window.location.href);
        if (this.limit > 0) {
          url.searchParams.set('limit', this.limit);
        } else {
          url.searchParams.delete('limit');
        }
        window.history.replaceState({}, '', url.toString());
        this.showToast(`✨ Đã đặt số lượng ảnh cần chọn: ${this.limit > 0 ? this.limit + ' ảnh' : 'Không giới hạn'}`);
      }
    });

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

    this.selectedToolbar = document.getElementById('selected-toolbar');
    this.selectedToolbarCount = document.getElementById('selected-toolbar-count');
    this.btnToggleQuickDeselect = document.getElementById('btn-toggle-quick-deselect');
    this.quickToggleLabel = document.getElementById('quick-toggle-label');
    this.btnDeselectAll = document.getElementById('btn-deselect-all');
    this.barBtnQuickMode = document.getElementById('bar-btn-quick-mode');

    this.btnToggleQuickDeselect?.addEventListener('click', () => this.toggleQuickMode());
    this.barBtnQuickMode?.addEventListener('click', () => this.toggleQuickMode());
    this.btnDeselectAll?.addEventListener('click', () => this.deselectAllPhotos());

    // Filter pills
    const pills = document.querySelectorAll('.filter-pill');
    pills.forEach((p) => {
      p.addEventListener('click', () => {
        this.currentFilter = p.dataset.filter;
        this.updateActiveFilterPill();
        this.applyFilters();
        this.updateSelectedToolbar();
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
      isQuickToggleMode: () => this.quickToggleMode,
      onToggleHeart: (id) => this.toggleHeart(id),
      onToggleStar: (id) => this.toggleStar(id),
      onOpenLightbox: (index, focusNote) => this.openLightboxAt(index, focusNote),
    });
  }

  handleRoute() {
    const isAdmin = window.location.hash === '#admin';
    if (isAdmin) {
      this.siteHeader.classList.add('hidden');
      this.galleryContainer.classList.add('hidden');
      this.floatingBarWrap.classList.add('hidden');
      this.faceActiveBanner.classList.add('hidden');
      if (this.peopleBar) this.peopleBar.classList.add('hidden');
      this.adminView.classList.remove('hidden');
      this.adminManager?.checkAuthState();
    } else {
      this.siteHeader.classList.remove('hidden');
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

  async loadAlbumData(forceRefresh = false) {
    this.showState('loading', forceRefresh ? 'Đang tải lại danh sách ảnh mới nhất từ Google Drive...' : 'Đang kết nối thư mục Google Drive...');
    try {
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

      if (this.allPhotos.length === 0) {
        this.showState('empty', 'Thư mục Google Drive này chưa có file ảnh nào.');
        return;
      }

      this.renderFolderTabs();
      this.loadCachedClusters();

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
      if (this.syncStatusText) this.syncStatusText.textContent = text || 'Đã đồng bộ';
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
    this.faceScanStatusTitle = document.getElementById('face-scan-status-title');
    this.faceScanStatusDesc = document.getElementById('face-scan-status-desc');
    this.faceBtnBack = document.getElementById('face-btn-back');
    this.faceBtnBackground = document.getElementById('face-btn-background');

    // Clusters step elements
    this.faceStepClusters = document.getElementById('face-step-clusters');
    this.faceClustersGrid = document.getElementById('face-clusters-grid');
    this.faceBtnRescan = document.getElementById('face-btn-rescan');
    this.faceBtnCustomSample = document.getElementById('face-btn-custom-sample');
    this.faceClusters = [];

    // Floating background scan pill
    this.faceFloatingPill = document.getElementById('face-floating-pill');
    this.facePillText = document.getElementById('face-pill-text');
    this.facePillFill = document.getElementById('face-pill-fill');
    this.facePillOpen = document.getElementById('face-pill-open');
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

    this.faceBtnRescan?.addEventListener('click', () => {
      this.startAutoClusterScan();
    });

    this.faceBtnCustomSample?.addEventListener('click', () => {
      this.showFaceStep('pick');
      this.renderFacePickerGrid();
    });
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

  openFaceModal() {
    this.faceModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (this.faceClusters && this.faceClusters.length > 0) {
      this.showFaceStep('clusters');
      this.renderFaceClustersGrid();
    } else {
      this.startAutoClusterScan();
    }
  }

  closeFaceModal() {
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

  async startAutoClusterScan() {
    this.showFaceStep('scan');
    this.faceScanStatusTitle.textContent = 'Đang tự động phát hiện và gom nhóm khuôn mặt...';
    this.isScanningFace = true;

    try {
      const defaultThreshold = STUDIO_CONFIG.faceAI.defaultThreshold || 0.52;
      const clusters = await this.faceEngine.scanAndClusterAlbum(
        this.allPhotos,
        (p) => {
          const pct = Math.round((p.current / (p.total || 1)) * 100);
          this.faceScanProgressFill.style.width = `${pct}%`;
          if (p.phase === 'clustering') {
            this.faceScanStatusDesc.textContent = 'Đang phân tích các đặc trưng khuôn mặt khác nhau...';
            if (this.facePillText) this.facePillText.textContent = 'Đang phân nhóm khuôn mặt...';
          } else {
            this.faceScanStatusDesc.textContent = `Đang xử lý ${p.current} / ${p.total} ảnh (đã lưu cache IndexedDB)...`;
            if (this.facePillText && this.facePillFill) {
              this.facePillText.textContent = `Đang quét AI: ${p.current} / ${p.total} ảnh (${pct}%)`;
              this.facePillFill.style.width = `${pct}%`;
            }
          }
        },
        defaultThreshold
      );

      this.faceClusters = clusters;
      this.isScanningFace = false;
      this.saveCachedClusters();
      this.renderPeopleBar();
      if (this.faceFloatingPill) this.faceFloatingPill.classList.add('hidden');

      if (clusters.length === 0) {
        alert('Không tìm thấy khuôn mặt rõ nét nào trong album.');
        this.closeFaceModal();
        return;
      }

      this.restoreFaceModal();
      this.showFaceStep('clusters');
      this.renderFaceClustersGrid();
      this.showToast(`Phát hiện ${clusters.length} người khác nhau trong album!`, 'success');
    } catch (err) {
      this.isScanningFace = false;
      console.error(err);
      alert('Lỗi quét khuôn mặt: ' + err.message);
      this.closeFaceModal();
    }
  }

  saveCachedClusters() {
    if (!this.faceClusters || this.faceClusters.length === 0) return;
    try {
      const key = `studio_clusters_${this.folderId || 'demo'}`;
      const data = this.faceClusters.map((c) => ({
        id: c.id,
        label: c.label,
        avatarUrl: c.avatarUrl,
        photoCount: c.photoCount,
        photoIds: Array.from(c.photoIds),
      }));
      localStorage.setItem(key, JSON.stringify(data));
    } catch {
      // ignore
    }
  }

  loadCachedClusters() {
    try {
      const key = `studio_clusters_${this.folderId || 'demo'}`;
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.length > 0) {
        this.faceClusters = data.map((item) => ({
          ...item,
          photoIds: new Set(item.photoIds),
        }));
        this.renderPeopleBar();
      }
    } catch {
      // ignore
    }
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
        <span class="cluster-label">${cluster.label}</span>
        <span class="cluster-count">${cluster.photoCount} ảnh</span>
      `;
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
    this.faceScanStatusTitle.textContent = 'Đang quét toàn bộ album ảnh...';
    this.isScanningFace = true;

    try {
      const scores = await this.faceEngine.scanAlbumForFace(
        this.allPhotos,
        embedding,
        (p) => {
          const pct = Math.round((p.current / (p.total || 1)) * 100);
          this.faceScanProgressFill.style.width = `${pct}%`;
          this.faceScanStatusDesc.textContent = `Đang xử lý ${p.current} / ${p.total} ảnh (đã lưu cache IndexedDB)...`;

          if (this.facePillText && this.facePillFill) {
            this.facePillText.textContent = `Đang quét AI: ${p.current} / ${p.total} ảnh (${pct}%)`;
            this.facePillFill.style.width = `${pct}%`;
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
