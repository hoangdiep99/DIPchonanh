/**
 * Phân hệ 3.2: Trình xem lớn (Lightbox Modal)
 * - Hỗ trợ tải tiến cấp w800 -> w2048 mượt mà
 * - Vuốt trái/phải trên màn hình cảm ứng & phím mũi tên trên máy tính
 * - Phóng to chi tiết (Zoom) bằng nút, cuộn chuột, chạm đúp, chụm 2 ngón & kéo di chuyển
 * - Khu vực thao tác nhanh nằm gọn dưới đáy (có thể thu gọn): Chọn, Ưu tiên, Quick Tags, Ghi chú
 */
import { attachImageWithFallback } from './drive.js?v=8.5';
import { ICONS } from './icons.js?v=8.5';

export class LightboxModal {
  constructor(modalEl, options) {
    this.modalEl = modalEl;
    this.quickTags = options.quickTags || [];
    this.allowDownload = options.allowDownload;
    this.callbacks = options.callbacks; // { getSelection, onToggleHeart, onToggleStar, onToggleTag, onUpdateNote, onFindFaceFromPhoto }

    this.photos = [];
    this.currentIndex = 0;
    this.isOpen = false;
    this.isDockCollapsed = false;
    this.isSuperResLoaded = false;
    this.isLoadingSuperRes = false;

    // Trạng thái Zoom & Pan
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragOriginX = 0;
    this.dragOriginY = 0;
    this.swipeStartX = 0;
    this.swipeStartY = 0;
    this.pinchStartDist = 0;
    this.pinchStartScale = 1;
    this.lastTapTime = 0;
    this.activeLoadToken = 0;

    this.bindElements();
    this.bindEvents();
  }

  bindElements() {
    this.indexEl = this.modalEl.querySelector('#lb-index');
    this.filenameEl = this.modalEl.querySelector('#lb-filename');
    this.folderEl = this.modalEl.querySelector('#lb-folder');
    this.stageEl = this.modalEl.querySelector('#lb-stage');
    this.imgContainerEl = this.modalEl.querySelector('#lb-img-container');
    this.imgEl = this.modalEl.querySelector('#lb-img');
    this.loaderEl = this.modalEl.querySelector('#lb-loader');

    this.prevBtn = this.modalEl.querySelector('#lb-prev');
    this.nextBtn = this.modalEl.querySelector('#lb-next');
    this.closeBtn = this.modalEl.querySelector('#lb-close');
    this.hdBtn = this.modalEl.querySelector('#lb-hd-btn');
    this.zoomInBtn = this.modalEl.querySelector('#lb-zoom-in');
    this.zoomOutBtn = this.modalEl.querySelector('#lb-zoom-out');
    this.zoomResetBtn = this.modalEl.querySelector('#lb-zoom-reset');
    this.downloadLink = this.modalEl.querySelector('#lb-download');

    this.collapseToggleBtn = this.modalEl.querySelector('#lb-collapse-toggle');
    this.dockEl = this.modalEl.querySelector('#lb-dock');
    this.heartBtn = this.modalEl.querySelector('#lb-heart-btn');
    this.starBtn = this.modalEl.querySelector('#lb-star-btn');
    this.faceBtn = this.modalEl.querySelector('#lb-face-btn');
    this.coverBtn = this.modalEl.querySelector('#lb-cover-btn');
    this.noteToggleBtn = this.modalEl.querySelector('#lb-note-toggle-btn');
    this.notesDrawer = this.modalEl.querySelector('#lb-notes-drawer');
    this.notesCloseBtn = this.modalEl.querySelector('#lb-notes-close');
    this.noteDot = this.modalEl.querySelector('#lb-note-dot');
    this.quickTagsEl = this.modalEl.querySelector('#lb-quick-tags');
    this.noteInput = this.modalEl.querySelector('#lb-note-input');
    this.noteSaveBtn = this.modalEl.querySelector('#lb-note-save-btn');

    // Khởi tạo các chip Quick Tag một chạm (ấn vào tự động điền/bỏ ghi chú)
    this.quickTagsEl.innerHTML = '';
    for (const tag of this.quickTags) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quick-tag-chip';
      btn.dataset.tag = tag;
      btn.textContent = tag;
      btn.addEventListener('click', () => {
        const photo = this.currentPhoto();
        if (!photo) return;
        this.callbacks.onToggleTag(photo.id, tag);
        const sel = this.callbacks.getSelection(photo.id);
        const isTagActive = sel.tags && sel.tags.includes(tag);

        let currentNote = (this.noteInput.value || '').trim();
        if (isTagActive) {
          if (!currentNote.includes(tag)) {
            currentNote = currentNote ? `${currentNote}, ${tag}` : tag;
          }
        } else {
          currentNote = currentNote.replace(new RegExp(`(^|,\\s*)${tag}`, 'gi'), '').replace(/^,\\s*/, '').trim();
        }
        this.noteInput.value = currentNote;
        this.callbacks.onUpdateNote(photo.id, currentNote);
        this.syncControls();
      });
      this.quickTagsEl.appendChild(btn);
    }

    if (!this.allowDownload && this.downloadLink) {
      this.downloadLink.classList.add('hidden');
    }
  }

  bindEvents() {
    this.closeBtn.addEventListener('click', () => this.close());
    this.prevBtn.addEventListener('click', () => this.navigate(-1));
    this.nextBtn.addEventListener('click', () => this.navigate(1));

    this.hdBtn?.addEventListener('click', () => this.toggleSuperRes());
    this.zoomInBtn.addEventListener('click', () => this.setZoom(this.scale + 0.6));
    this.zoomOutBtn.addEventListener('click', () => this.setZoom(this.scale - 0.6));
    this.zoomResetBtn.addEventListener('click', () => this.resetTransform());

    this.collapseToggleBtn?.addEventListener('click', () => {
      this.isDockCollapsed = !this.isDockCollapsed;
      this.renderCollapseState();
    });

    this.noteToggleBtn?.addEventListener('click', () => {
      if (!this.notesDrawer) return;
      const isHidden = this.notesDrawer.classList.toggle('hidden');
      this.noteToggleBtn.classList.toggle('is-active', !isHidden);
      if (!isHidden) {
        setTimeout(() => this.noteInput?.focus(), 80);
      }
    });

    this.notesCloseBtn?.addEventListener('click', () => {
      this.notesDrawer?.classList.add('hidden');
      this.noteToggleBtn?.classList.remove('is-active');
    });

    this.heartBtn.addEventListener('click', () => {
      const photo = this.currentPhoto();
      if (!photo) return;
      this.callbacks.onToggleHeart(photo.id);
      this.syncControls();
    });

    this.starBtn.addEventListener('click', () => {
      const photo = this.currentPhoto();
      if (!photo) return;
      this.callbacks.onToggleStar(photo.id);
      this.syncControls();
    });

    this.faceBtn?.addEventListener('click', () => {
      const photo = this.currentPhoto();
      if (!photo) return;
      this.close();
      this.callbacks.onFindFaceFromPhoto?.(photo);
    });

    const saveAndCloseNote = () => {
      const photo = this.currentPhoto();
      if (!photo) return;
      const noteVal = this.noteInput.value.trim();
      this.callbacks.onUpdateNote(photo.id, noteVal);
      this.syncControls();
      this.notesDrawer?.classList.add('hidden');
      this.noteToggleBtn?.classList.remove('is-active');
      if (typeof this.callbacks.showToast === 'function') {
        this.callbacks.showToast('✅ Đã lưu ghi chú cho ảnh!', 'success');
      }
    };

    this.noteSaveBtn?.addEventListener('click', saveAndCloseNote);
    this.noteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveAndCloseNote();
      }
    });

    this.noteInput.addEventListener('input', () => {
      const photo = this.currentPhoto();
      if (!photo) return;
      this.callbacks.onUpdateNote(photo.id, this.noteInput.value);
      this.syncControls(false);
    });

    // Tải ảnh trực tiếp chất lượng cao (không chuyển trang Google Drive)
    this.downloadLink?.addEventListener('click', (e) => {
      e.preventDefault();
      const photo = this.currentPhoto();
      if (photo && this.callbacks.onDownloadPhoto) {
        this.callbacks.onDownloadPhoto(photo);
      }
    });

    // Phím tắt máy tính
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      const isTyping =
        document.activeElement === this.noteInput ||
        document.activeElement?.tagName === 'TEXTAREA';

      if (e.key === 'Escape') {
        if (isTyping) {
          this.noteInput.blur();
        } else if (this.scale > 1) {
          this.resetTransform();
        } else {
          this.close();
        }
        return;
      }

      if (isTyping) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.navigate(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.navigate(1);
      } else if (e.key === 'h' || e.key === 'H' || e.key === ' ') {
        e.preventDefault();
        const photo = this.currentPhoto();
        if (photo) {
          this.callbacks.onToggleHeart(photo.id);
          this.syncControls();
        }
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        const photo = this.currentPhoto();
        if (photo) {
          this.callbacks.onToggleStar(photo.id);
          this.syncControls();
        }
      } else if (e.key === '+' || e.key === '=') {
        this.setZoom(this.scale + 0.5);
      } else if (e.key === '-') {
        this.setZoom(this.scale - 0.5);
      } else if (e.key === '0') {
        this.resetTransform();
      } else if (e.key === 'z' || e.key === 'Z') {
        this.setZoom(this.scale > 1.05 ? 1 : 2.3);
      }
    });

    // Ngăn trình duyệt kéo ảnh mặc định khi kéo chuột trên máy tính
    this.imgEl?.addEventListener('dragstart', (e) => e.preventDefault());

    // Cuộn chuột để zoom đúng vào vị trí con trỏ trên máy tính
    this.stageEl.addEventListener(
      'wheel',
      (e) => {
        if (!this.isOpen) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.18 : 0.84;
        const target = this.scale * factor;
        if (target <= 1.02) {
          this.setZoom(1, false);
        } else {
          this.zoomAtPoint(target, e.clientX, e.clientY, false);
        }
      },
      { passive: false }
    );

    // Nhấp đúp chuột để zoom nhanh đúng vào vị trí vừa bấm
    this.stageEl.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      if (this.scale > 1.05) {
        this.setZoom(1, true);
      } else {
        this.zoomAtPoint(2.5, e.clientX, e.clientY, true);
      }
    });

    // Kéo chuột: khi đang zoom thì pan, khi chưa zoom thì kéo trái/phải để lật ảnh mượt mà
    this.mouseSwipeMode = false;
    this.stageEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.dragOriginX = this.translateX;
      this.dragOriginY = this.translateY;
      this.mouseSwipeMode = this.scale <= 1.02;
      this.stageEl.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.dragStartX;
      const dy = e.clientY - this.dragStartY;
      if (this.mouseSwipeMode) {
        if (Math.abs(dx) > 6) {
          this.imgContainerEl.style.transition = 'none';
          this.imgContainerEl.style.opacity = String(Math.max(0.55, 1 - Math.abs(dx) / 520));
          this.imgContainerEl.style.transform = `translate3d(${dx * 0.65}px, 0, 0)`;
        }
      } else {
        this.translateX = this.dragOriginX + dx;
        this.translateY = this.dragOriginY + dy;
        this.applyTransform(false);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (!this.isDragging) return;
      this.isDragging = false;
      this.stageEl.style.cursor = '';
      this.imgContainerEl.style.opacity = '';

      if (this.mouseSwipeMode) {
        this.mouseSwipeMode = false;
        const dx = e.clientX - this.dragStartX;
        const dy = e.clientY - this.dragStartY;
        if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.1) {
          this.navigate(dx < 0 ? 1 : -1);
        } else {
          this.applyTransform(true);
        }
        return;
      }

      this.clampPan();
      this.applyTransform(true);
    });

    // Cảm ứng: Vuốt trái/phải mượt mà, chụm 2 ngón zoom đúng tâm, chạm đúp zoom đúng vị trí chạm, kéo 1 ngón pan
    this.isPinching = false;
    this.pinchMidX = 0;
    this.pinchMidY = 0;
    this.swipeStartTime = 0;

    this.stageEl.addEventListener(
      'touchstart',
      (e) => {
        if (e.target.closest('button')) return;

        if (e.touches.length === 2) {
          this.isDragging = false;
          this.isPinching = true;
          this.pinchStartDist = this.touchDistance(e.touches);
          this.pinchStartScale = this.scale;
          this.pinchOriginX = this.translateX;
          this.pinchOriginY = this.translateY;
          const rect = this.stageEl.getBoundingClientRect();
          this.pinchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - (rect.left + rect.width / 2);
          this.pinchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - (rect.top + rect.height / 2);
          return;
        }

        if (e.touches.length === 1 && !this.isPinching) {
          const touch = e.touches[0];
          const now = Date.now();
          if (now - this.lastTapTime < 280) {
            // Chạm 2 lần: zoom thẳng vào đúng vùng ảnh vừa chạm (hoặc thu về 100%)
            if (this.scale > 1.05) {
              this.setZoom(1, true);
            } else {
              this.zoomAtPoint(2.5, touch.clientX, touch.clientY);
            }
            this.lastTapTime = 0;
            this.isDragging = false;
            return;
          }
          this.lastTapTime = now;

          this.swipeStartX = touch.clientX;
          this.swipeStartY = touch.clientY;
          this.swipeStartTime = now;
          this.dragOriginX = this.translateX;
          this.dragOriginY = this.translateY;
          this.isDragging = true;
        }
      },
      { passive: true }
    );

    this.stageEl.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length === 2 && this.isPinching && this.pinchStartDist > 0) {
          e.preventDefault();
          const dist = this.touchDistance(e.touches);
          const nextScale = Math.max(1, Math.min(4.5, this.pinchStartScale * (dist / this.pinchStartDist)));
          const ratio = nextScale / this.pinchStartScale;
          const rect = this.stageEl.getBoundingClientRect();
          const curMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - (rect.left + rect.width / 2);
          const curMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - (rect.top + rect.height / 2);

          this.translateX = curMidX - (this.pinchMidX - this.pinchOriginX) * ratio;
          this.translateY = curMidY - (this.pinchMidY - this.pinchOriginY) * ratio;
          this.setZoom(nextScale, false);
          return;
        }

        if (e.touches.length === 1 && this.isDragging && !this.isPinching) {
          const dx = e.touches[0].clientX - this.swipeStartX;
          const dy = e.touches[0].clientY - this.swipeStartY;

          if (this.scale > 1.02) {
            e.preventDefault();
            this.translateX = this.dragOriginX + dx;
            this.translateY = this.dragOriginY + dy;
            this.applyTransform(false);
          } else if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) {
            // Kéo mượt theo ngón tay kèm làm mờ nhẹ khi vuốt chuyển ảnh
            e.preventDefault();
            this.imgContainerEl.style.transition = 'none';
            this.imgContainerEl.style.opacity = String(Math.max(0.55, 1 - Math.abs(dx) / 480));
            this.imgContainerEl.style.transform = `translate3d(${dx * 0.72}px, 0, 0)`;
          }
        }
      },
      { passive: false }
    );

    this.stageEl.addEventListener('touchend', (e) => {
      if (this.isPinching) {
        if (e.touches.length < 2) {
          this.isPinching = false;
          this.pinchStartDist = 0;
          if (this.scale <= 1.02) {
            this.resetTransform(true);
          } else {
            this.clampPan();
            this.applyTransform(true);
          }
        }
        return;
      }

      if (!this.isDragging) return;
      this.isDragging = false;
      this.imgContainerEl.style.opacity = '';

      if (this.scale > 1.02) {
        this.clampPan();
        this.applyTransform(true);
        return;
      }

      const touch = e.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - this.swipeStartX;
      const dy = touch.clientY - this.swipeStartY;
      const elapsed = Math.max(1, Date.now() - (this.swipeStartTime || Date.now()));
      const isQuickSwipe = Math.abs(dx) > 28 && elapsed < 260;

      if ((Math.abs(dx) > 45 || isQuickSwipe) && Math.abs(dx) > Math.abs(dy) * 1.1) {
        this.navigate(dx < 0 ? 1 : -1);
      } else {
        this.applyTransform(true);
      }
    });
  }

  zoomAtPoint(targetScale, clientX, clientY, animate = true) {
    if (targetScale <= 1.05) {
      this.setZoom(1, true);
      return;
    }
    const rect = this.stageEl.getBoundingClientRect();
    const offsetX = clientX - (rect.left + rect.width / 2);
    const offsetY = clientY - (rect.top + rect.height / 2);
    const nextScale = Math.max(1, Math.min(4.5, targetScale));
    const ratio = nextScale / this.scale;
    this.translateX = offsetX * (1 - ratio) + this.translateX * ratio;
    this.translateY = offsetY * (1 - ratio) + this.translateY * ratio;
    this.setZoom(nextScale, animate);
  }
  touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  currentPhoto() {
    return this.photos[this.currentIndex] || null;
  }

  open(photos, index, focusNote = false) {
    if (!photos || photos.length === 0) return;
    this.photos = photos;
    this.currentIndex = Math.max(0, Math.min(index, photos.length - 1));
    this.isOpen = true;
    if (this.collapseToggleBtn) this.renderCollapseState();

    if (focusNote) {
      this.notesDrawer?.classList.remove('hidden');
      this.noteToggleBtn?.classList.add('is-active');
    } else {
      this.notesDrawer?.classList.add('hidden');
      this.noteToggleBtn?.classList.remove('is-active');
    }

    this.modalEl.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    this.renderCurrentPhoto();
    if (focusNote) {
      setTimeout(() => this.noteInput.focus(), 80);
    }
  }

  close() {
    this.isOpen = false;
    this.modalEl.classList.add('hidden');
    document.body.style.overflow = '';
    this.resetTransform();
  }

  navigate(delta) {
    if (this.photos.length <= 1) return;
    this.currentIndex = (this.currentIndex + delta + this.photos.length) % this.photos.length;
    this.resetTransform(false);
    this.renderCurrentPhoto();
  }

  renderCurrentPhoto() {
    const photo = this.currentPhoto();
    if (!photo) return;

    this.indexEl.textContent = `${this.currentIndex + 1} / ${this.photos.length}`;
    this.filenameEl.textContent = photo.name;
    this.folderEl.textContent = photo.folderName || '';
    this.folderEl.classList.toggle('hidden', !photo.folderName);

    if (this.downloadLink && this.allowDownload) {
      this.downloadLink.title = `Tải ảnh ${photo.name} về máy`;
    }

    this.prevBtn.classList.toggle('hidden', this.photos.length <= 1);
    this.nextBtn.classList.toggle('hidden', this.photos.length <= 1);

    // Hiển thị tức thì ảnh w800 đã cache trong lưới, sau đó nâng cấp lên w2560 mượt mà
    const token = ++this.activeLoadToken;
    this.isSuperResLoaded = false;
    this.isLoadingSuperRes = false;
    this.updateHdBadge();

    this.imgEl.src = photo.gridUrl;
    this.imgEl.alt = photo.name;

    if (photo.lightboxUrl && photo.lightboxUrl !== photo.gridUrl) {
      this.loaderEl.classList.remove('hidden');
      this.loaderEl.textContent = 'Đang tải nét cao...';
      const hiRes = new Image();
      attachImageWithFallback(hiRes, photo.lightboxUrl, photo.lightboxFallbacks, (loaded) => {
        if (token !== this.activeLoadToken) return;
        this.imgEl.src = loaded.src;
        this.loaderEl.classList.add('hidden');
        // Tự động nâng cấp lên ảnh gốc độ nét cao (=s0) để ảnh luôn sắc nét và ấn giữ lưu được ảnh to
        this.ensureSuperResolution();
      });
    } else {
      this.loaderEl.classList.add('hidden');
    }

    // Tải trước nhẹ ảnh kế tiếp để vuốt không bị trễ
    const nextPhoto = this.photos[(this.currentIndex + 1) % this.photos.length];
    if (nextPhoto && nextPhoto.id !== photo.id) {
      const preload = new Image();
      preload.src = nextPhoto.lightboxUrl;
    }

    this.syncControls(true);
    this.renderQualityBadges();
  }

  syncControls(syncNoteInput = true) {
    const photo = this.currentPhoto();
    if (!photo) return;
    const sel = this.callbacks.getSelection(photo.id);

    this.heartBtn.classList.toggle('is-active', Boolean(sel.selected));
    this.heartBtn.innerHTML = `${ICONS.heart(Boolean(sel.selected))}<span>${
      sel.selected ? 'Đã chọn' : 'Chọn ảnh'
    }</span>`;

    this.starBtn.classList.toggle('is-active', Boolean(sel.priority));

    if (this.coverBtn) {
      const isOwner = Boolean(this.callbacks.isStudioOwner?.());
      this.coverBtn.classList.toggle('hidden', !isOwner);
    }
    this.starBtn.innerHTML = `${ICONS.star(Boolean(sel.priority))}<span>${
      sel.priority ? 'Ưu tiên / In' : 'Ưu tiên'
    }</span>`;

    const activeTags = new Set(sel.tags || []);
    for (const btn of this.quickTagsEl.querySelectorAll('.quick-tag-chip')) {
      btn.classList.toggle('is-active', activeTags.has(btn.dataset.tag));
    }

    if (syncNoteInput) {
      this.noteInput.value = sel.note || '';
    }

    const hasNotes = Boolean((sel.tags && sel.tags.length) || (sel.note && sel.note.trim()));
    if (this.noteDot) {
      this.noteDot.classList.toggle('hidden', !hasNotes);
    }
  }

  renderQualityBadges() {
    const el = this.modalEl?.querySelector('#lb-quality-badges');
    if (!el) return;
    const photo = this.currentPhoto();
    const q = photo ? this.callbacks.getQualityInfo?.(photo.id) : null;
    if (!q) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.innerHTML = '';
    const add = (cls, text) => {
      const b = document.createElement('span');
      b.className = `q-badge ${cls}`;
      b.textContent = text;
      el.appendChild(b);
    };
    if (q.isBest) add('q-best', `⭐ Tấm đẹp nhất (nhóm ${q.groupSize} ảnh)`);
    else if (q.groupId) add('q-dup', `🔁 Ảnh ${q.groupIndex}/${q.groupSize} trong nhóm giống nhau`);
    if (q.blink) add('q-blink', '😑 AI nghi có người nhắm mắt');
    if (q.blurry) add('q-blur', '😵 AI nghi ảnh bị mờ / rung máy');
    el.classList.toggle('hidden', el.children.length === 0);
  }

  renderCollapseState() {    if (!this.collapseToggleBtn) return;
    this.dockEl.classList.toggle('is-collapsed', this.isDockCollapsed);
    this.collapseToggleBtn.innerHTML = this.isDockCollapsed
      ? `${ICONS.chevronUp}<span>Hiện chọn ảnh</span>`
      : `${ICONS.chevronDown}<span>Thu gọn để xem toàn ảnh</span>`;
  }

  setZoom(nextScale, animate = true) {
    this.scale = Math.max(1, Math.min(4, Number(nextScale.toFixed(2))));
    if (this.scale <= 1.01) {
      this.scale = 1;
      this.translateX = 0;
      this.translateY = 0;
      if (this.zoomResetBtn) this.zoomResetBtn.textContent = 'Vừa khung';
    } else {
      this.clampPan();
      if (this.zoomResetBtn) this.zoomResetBtn.textContent = `${Math.round(this.scale * 100)}%`;
      // Khi phóng to > 1.25x để soi chi tiết (mắt, da, răng, tóc), tự động tải ảnh gốc nguyên bản (s0)
      if (this.scale > 1.25) {
        this.ensureSuperResolution();
      }
    }
    this.applyTransform(animate);
  }

  updateHdBadge() {
    if (!this.hdBtn) return;
    if (this.isLoadingSuperRes) {
      this.hdBtn.classList.add('is-loading');
      this.hdBtn.innerHTML = '<span>⏳ Đang nạp nét gốc...</span>';
      this.hdBtn.title = 'Đang nạp ảnh gốc độ phân giải cảm biến...';
    } else if (this.isSuperResLoaded) {
      this.hdBtn.classList.remove('is-loading');
      this.hdBtn.classList.add('is-active');
      this.hdBtn.innerHTML = '<span>✨ Nét gốc 100%</span>';
      this.hdBtn.title = 'Đang hiển thị ảnh gốc cảm biến sắc nét tối đa';
    } else {
      this.hdBtn.classList.remove('is-loading', 'is-active');
      this.hdBtn.innerHTML = '<span>HD Gốc</span>';
      this.hdBtn.title = 'Bấm để nạp ảnh gốc siêu nét (cảm biến đầy đủ)';
    }
  }

  ensureSuperResolution() {
    const photo = this.currentPhoto();
    if (!photo || this.isSuperResLoaded || this.isLoadingSuperRes) return;
    if (!photo.originalUrl) return;

    this.isLoadingSuperRes = true;
    this.updateHdBadge();
    const token = this.activeLoadToken;

    const superImg = new Image();
    attachImageWithFallback(superImg, photo.originalUrl, photo.originalFallbacks, (loaded) => {
      if (token !== this.activeLoadToken) return;
      this.imgEl.src = loaded.src;
      this.isSuperResLoaded = true;
      this.isLoadingSuperRes = false;
      this.updateHdBadge();
    });
  }

  toggleSuperRes() {
    if (this.isSuperResLoaded) {
      return;
    }
    this.ensureSuperResolution();
  }

  resetTransform(animate = true) {
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    if (this.zoomResetBtn) this.zoomResetBtn.textContent = 'Vừa khung';
    this.applyTransform(animate);
  }

  clampPan() {
    const maxOffsetX = (this.stageEl.clientWidth * (this.scale - 1)) / 2;
    const maxOffsetY = (this.stageEl.clientHeight * (this.scale - 1)) / 2;
    this.translateX = Math.max(-maxOffsetX, Math.min(maxOffsetX, this.translateX));
    this.translateY = Math.max(-maxOffsetY, Math.min(maxOffsetY, this.translateY));
  }

  applyTransform(animate = true) {
    this.imgContainerEl.style.transition = animate ? 'transform 0.18s ease-out' : 'none';
    this.imgContainerEl.style.transform = `translate3d(${this.translateX}px, ${this.translateY}px, 0) scale(${this.scale})`;
  }
}
