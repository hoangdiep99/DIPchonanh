/**
 * Phân hệ 3.2: Lưới ảnh Responsive Justified Grid giữ nguyên tỷ lệ khung hình gốc
 * (gap 8px trên mobile, 12px trên desktop) + Lazy Loading qua IntersectionObserver.
 */
import { attachImageWithFallback } from './drive.js?v=8.5';
import { ICONS } from './icons.js?v=8.5';

export class GalleryGrid {
  constructor(containerEl, callbacks) {
    this.containerEl = containerEl;
    this.callbacks = callbacks; // { getSelection, allowDownload, onToggleHeart, onToggleStar, onOpenLightbox, getFaceScore }
    this.photos = [];
    this.cardMap = new Map();
    this.resizeRaf = null;
    this.relayoutTimer = null;
    this.lastWidth = 0;

    // IntersectionObserver để chỉ gán src khi ảnh tiến gần khung nhìn (chống tràn RAM)
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const img = entry.target;
          this.observer.unobserve(img);
          const photo = img._photoRef;
          if (!photo) continue;
          attachImageWithFallback(img, photo.gridUrl, photo.gridFallbacks, (loadedImg) => {
            const wrap = loadedImg.closest('.photo-img-wrap');
            if (wrap) wrap.classList.add('is-ready');

            // Nếu ảnh không có sẵn metadata kích thước từ Drive, cập nhật tỷ lệ thật sau khi tải
            if (!photo.hasExactSize && loadedImg.naturalWidth && loadedImg.naturalHeight) {
              const realRatio = loadedImg.naturalWidth / loadedImg.naturalHeight;
              if (Math.abs(realRatio - photo.aspectRatio) > 0.05) {
                photo.width = loadedImg.naturalWidth;
                photo.height = loadedImg.naturalHeight;
                photo.aspectRatio = realRatio;
                photo.hasExactSize = true;
                this.scheduleRelayout();
              }
            }
          });
        }
      },
      { rootMargin: '420px 0px', threshold: 0.01 }
    );

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = requestAnimationFrame(() => {
        const w = Math.floor(this.containerEl.clientWidth);
        if (w > 0 && Math.abs(w - this.lastWidth) >= 2) {
          this.layoutRows();
        }
      });
    });
    this.resizeObserver.observe(this.containerEl);
  }

  scheduleRelayout() {
    if (this.relayoutTimer) clearTimeout(this.relayoutTimer);
    this.relayoutTimer = setTimeout(() => this.layoutRows(), 140);
  }

  setPhotos(photos) {
    this.photos = photos;
    this.render();
  }

  /**
   * Tính toán bố cục từng hàng giữ nguyên tỷ lệ khung hình (Justified Layout).
   */
  computeRows(containerWidth) {
    const isDesktop = window.innerWidth >= 768;
    const gap = isDesktop ? 12 : 8;
    const targetHeight =
      containerWidth >= 1200 ? 295 : containerWidth >= 768 ? 245 : 205;

    const rows = [];
    let currentRow = [];
    let ratioSum = 0;

    for (let i = 0; i < this.photos.length; i++) {
      const photo = this.photos[i];
      // Giới hạn nhẹ tỷ lệ cực đoan để ảnh panorama/siêu dọc vẫn đẹp mắt
      const ratio = Math.max(0.45, Math.min(2.6, photo.aspectRatio || 1.5));
      currentRow.push({ photo, ratio, index: i });
      ratioSum += ratio;

      const totalGap = gap * (currentRow.length - 1);
      const rowWidthAtTarget = ratioSum * targetHeight + totalGap;

      if (rowWidthAtTarget >= containerWidth) {
        const availableWidth = containerWidth - totalGap;
        const rowHeight = Math.max(120, availableWidth / ratioSum);
        rows.push({
          items: currentRow,
          height: rowHeight,
          isFull: true,
          gap,
        });
        currentRow = [];
        ratioSum = 0;
      }
    }

    // Hàng cuối cùng chưa đủ độ rộng: giữ chiều cao tự nhiên, không kéo giãn méo bố cục
    if (currentRow.length > 0) {
      const totalGap = gap * (currentRow.length - 1);
      const availableWidth = containerWidth - totalGap;
      const naturalHeight = Math.min(targetHeight * 1.15, availableWidth / ratioSum);
      const fillRatio = (ratioSum * naturalHeight + totalGap) / containerWidth;
      const finalHeight =
        fillRatio > 0.78 ? Math.min(targetHeight * 1.25, availableWidth / ratioSum) : targetHeight;

      rows.push({
        items: currentRow,
        height: Math.max(140, finalHeight),
        isFull: fillRatio > 0.78,
        gap,
      });
    }

    return rows;
  }

  render() {
    this.observer.disconnect();
    this.cardMap.clear();
    this.containerEl.innerHTML = '';

    if (this.photos.length === 0) {
      return;
    }

    const containerWidth = Math.floor(this.containerEl.clientWidth) || Math.min(window.innerWidth - 24, 1424);
    this.lastWidth = containerWidth;
    const rows = this.computeRows(containerWidth);

    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'gallery-row';

      for (const item of row.items) {
        const width = Math.floor(row.height * item.ratio);
        const height = Math.floor(row.height);
        const card = this.createCard(item.photo, item.index, width, height, row.isFull, item.ratio);
        this.cardMap.set(item.photo.id, card);
        rowEl.appendChild(card);
      }

      frag.appendChild(rowEl);
    }

    this.containerEl.appendChild(frag);
  }

  /**
   * Tính lại kích thước các hàng khi resize màn hình mà không làm mất ảnh đã tải.
   */
  layoutRows() {
    if (this.photos.length === 0) return;
    const containerWidth = Math.floor(this.containerEl.clientWidth);
    if (!containerWidth) return;
    this.lastWidth = containerWidth;

    const rows = this.computeRows(containerWidth);
    const frag = document.createDocumentFragment();

    for (const row of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'gallery-row';

      for (const item of row.items) {
        const existingCard = this.cardMap.get(item.photo.id);
        const width = Math.floor(row.height * item.ratio);
        const height = Math.floor(row.height);

        if (existingCard) {
          existingCard.style.height = `${height}px`;
          if (row.isFull) {
            existingCard.style.flex = `${item.ratio} 1 0px`;
            existingCard.style.width = '';
          } else {
            existingCard.style.flex = '0 0 auto';
            existingCard.style.width = `${width}px`;
          }
          rowEl.appendChild(existingCard);
        }
      }
      frag.appendChild(rowEl);
    }

    this.containerEl.innerHTML = '';
    this.containerEl.appendChild(frag);
  }

  createCard(photo, index, width, height, isFullRow, ratio) {
    const sel = this.callbacks.getSelection(photo.id);
    const faceScore = this.callbacks.getFaceScore?.(photo.id);
    const hasNotes = this.hasNoteData(sel);

    const card = document.createElement('article');
    card.className = 'photo-card';
    card.dataset.photoId = photo.id;
    card.style.height = `${height}px`;
    if (isFullRow) {
      card.style.flex = `${ratio} 1 0px`;
    } else {
      card.style.flex = '0 0 auto';
      card.style.width = `${width}px`;
    }

    if (sel.selected) card.classList.add('is-selected');
    if (sel.priority) card.classList.add('is-priority');

    // Khung ảnh + lazy img
    const imgWrap = document.createElement('div');
    imgWrap.className = 'photo-img-wrap';

    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.alt = photo.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img._photoRef = photo;
    imgWrap.appendChild(img);
    this.observer.observe(img);

    // Góc trên trái: Điểm nhận diện khuôn mặt (nếu đang lọc mặt)
    const badgesLeft = document.createElement('div');
    badgesLeft.className = 'photo-badges-left';

    if (typeof faceScore === 'number') {
      const scorePill = document.createElement('span');
      scorePill.className = 'face-score-pill';
      scorePill.textContent = `${Math.round(faceScore * 100)}%`;
      scorePill.title = 'Độ tương đồng khuôn mặt';
      badgesLeft.appendChild(scorePill);
    }

    // Góc trên phải: Nút Kính Lúp (Xem To), Tim (Chọn) & Sao (Ưu tiên)
    const actions = document.createElement('div');
    actions.className = 'photo-actions';

    const zoomBtn = document.createElement('button');
    zoomBtn.type = 'button';
    zoomBtn.className = 'card-action-btn btn-zoom';
    zoomBtn.setAttribute('aria-label', `Xem chi tiết ${photo.name}`);
    zoomBtn.title = 'Phóng to xem chi tiết ảnh';
    zoomBtn.innerHTML = ICONS.zoomIn || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/></svg>`;
    zoomBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onOpenLightbox(index, false);
    });

    const starBtn = document.createElement('button');
    starBtn.type = 'button';
    starBtn.className = `card-action-btn btn-star${sel.priority ? ' is-active' : ''}`;
    starBtn.setAttribute('aria-label', `Ưu tiên / In phóng ${photo.name}`);
    starBtn.title = 'Ảnh ưu tiên / In phóng';
    starBtn.innerHTML = ICONS.star(sel.priority);
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onToggleStar(photo.id);
    });

    const heartBtn = document.createElement('button');
    heartBtn.type = 'button';
    heartBtn.className = `card-action-btn btn-heart${sel.selected ? ' is-active' : ''}`;
    heartBtn.setAttribute('aria-label', `Chọn ảnh ${photo.name}`);
    heartBtn.title = sel.selected ? 'Bấm để bỏ chọn ảnh này' : 'Thả tim chọn ảnh';
    heartBtn.innerHTML = ICONS.heart(sel.selected);
    heartBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onToggleHeart(photo.id);
    });

    actions.appendChild(zoomBtn);
    actions.appendChild(starBtn);
    actions.appendChild(heartBtn);

    // Nhãn chữ đỏ hiển thị rõ ảnh có ghi chú ở góc trên bên phải
    const redNoteBadge = document.createElement('div');
    redNoteBadge.className = `card-note-red-badge${hasNotes ? '' : ' hidden'}`;
    const previewNoteText = sel.note ? sel.note : (sel.tags && sel.tags.length ? sel.tags.join(', ') : 'Có ghi chú');
    redNoteBadge.innerHTML = `<span class="note-red-dot">💬</span><span class="note-red-text">${previewNoteText}</span>`;
    redNoteBadge.title = `Ghi chú: ${previewNoteText} (Bấm để xem/sửa)`;
    redNoteBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onOpenLightbox(index, true);
    });

    // Góc dưới: Tên file gọn & Nút Tải gốc trực tiếp (nếu download=1)
    const overlayBottom = document.createElement('div');
    overlayBottom.className = 'photo-overlay-bottom';

    const fileNameEl = document.createElement('span');
    fileNameEl.className = 'photo-filename';
    fileNameEl.textContent = photo.name;
    fileNameEl.title = photo.name;
    overlayBottom.appendChild(fileNameEl);

    if (this.callbacks.allowDownload) {
      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'card-download-btn';
      dlBtn.title = 'Tải ảnh chất lượng cao trực tiếp về máy';
      dlBtn.setAttribute('aria-label', `Tải ảnh ${photo.name}`);
      dlBtn.innerHTML = ICONS.download;
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.callbacks.onDownloadPhoto) {
          this.callbacks.onDownloadPhoto(photo);
        }
      });
      overlayBottom.appendChild(dlBtn);
    }

    card.appendChild(imgWrap);
    card.appendChild(badgesLeft);
    card.appendChild(actions);
    card.appendChild(redNoteBadge);
    card.appendChild(overlayBottom);

    // Thao tác ấn giữ (Long-press) để mở menu thao tác nhanh trên điện thoại & máy tính
    let longPressTimer = null;
    let isLongPressTriggered = false;
    let startX = 0;
    let startY = 0;

    const startPress = (x, y) => {
      isLongPressTriggered = false;
      startX = x;
      startY = y;
      longPressTimer = setTimeout(() => {
        isLongPressTriggered = true;
        if (this.callbacks.onPhotoLongPress) {
          this.callbacks.onPhotoLongPress(photo, index);
        }
      }, 450);
    };

    const cancelPress = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    card.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        startPress(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        const dx = Math.abs(e.touches[0].clientX - startX);
        const dy = Math.abs(e.touches[0].clientY - startY);
        if (dx > 10 || dy > 10) {
          cancelPress();
        }
      }
    }, { passive: true });

    card.addEventListener('touchend', () => cancelPress());
    card.addEventListener('touchcancel', () => cancelPress());

    card.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        startPress(e.clientX, e.clientY);
      }
    });

    card.addEventListener('mousemove', (e) => {
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (dx > 10 || dy > 10) {
        cancelPress();
      }
    });

    card.addEventListener('mouseup', () => cancelPress());
    card.addEventListener('mouseleave', () => cancelPress());

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cancelPress();
      if (this.callbacks.onPhotoLongPress) {
        this.callbacks.onPhotoLongPress(photo, index);
      }
    });

    card.addEventListener('click', (e) => {
      if (isLongPressTriggered) {
        isLongPressTriggered = false;
        return;
      }
      if (e.ctrlKey || e.altKey || e.shiftKey) {
        this.callbacks.onToggleHeart(photo.id);
        return;
      }
      this.callbacks.onOpenLightbox(index, false);
    });

    return card;
  }

  hasNoteData(sel) {
    return (sel.tags && sel.tags.length > 0) || Boolean(sel.note && sel.note.trim());
  }

  /**
   * Cập nhật nhanh trạng thái 1 thẻ ảnh (O(1), không vẽ lại toàn bộ lưới).
   */
  updateCardState(photoId, sel) {
    const card = this.cardMap.get(photoId);
    if (!card) return;

    card.classList.toggle('is-selected', Boolean(sel.selected));
    card.classList.toggle('is-priority', Boolean(sel.priority));

    // Nếu đang xem tab "Đã chọn" mà người dùng bỏ chọn ảnh,
    // làm mờ nhẹ ảnh đó để biểu thị trực quan mà lưới không bị nhảy vị trí
    const currentFilter = this.callbacks.getCurrentFilter ? this.callbacks.getCurrentFilter() : 'all';
    if (currentFilter === 'selected') {
      card.classList.toggle('is-unselected-temp', !sel.selected);
    } else {
      card.classList.remove('is-unselected-temp');
    }

    const heartBtn = card.querySelector('.btn-heart');
    if (heartBtn) {
      heartBtn.classList.toggle('is-active', Boolean(sel.selected));
      heartBtn.title = sel.selected ? 'Bấm để bỏ chọn ảnh này' : 'Thả tim chọn ảnh';
      heartBtn.innerHTML = ICONS.heart(Boolean(sel.selected));
    }

    const starBtn = card.querySelector('.btn-star');
    if (starBtn) {
      starBtn.classList.toggle('is-active', Boolean(sel.priority));
      starBtn.innerHTML = ICONS.star(Boolean(sel.priority));
    }

    const redNoteBadge = card.querySelector('.card-note-red-badge');
    if (redNoteBadge) {
      const hasNotes = this.hasNoteData(sel);
      redNoteBadge.classList.toggle('hidden', !hasNotes);
      if (hasNotes) {
        const previewNoteText = sel.note ? sel.note : (sel.tags && sel.tags.length ? sel.tags.join(', ') : 'Có ghi chú');
        const textSpan = redNoteBadge.querySelector('.note-red-text');
        if (textSpan) textSpan.textContent = previewNoteText;
        redNoteBadge.title = `Ghi chú: ${previewNoteText} (Bấm để xem/sửa)`;
      }
    }
  }
}
