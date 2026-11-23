/**
 * Phân hệ 3.2: Lưới ảnh Responsive Justified Grid giữ nguyên tỷ lệ khung hình gốc
 * (gap 8px trên mobile, 12px trên desktop) + Lazy Loading qua IntersectionObserver.
 */
import { attachImageWithFallback } from './drive.js?v=8.3';
import { ICONS } from './icons.js?v=8.3';

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

    // Góc trên trái: Điểm nhận diện khuôn mặt + Biểu tượng ghi chú
    const badgesLeft = document.createElement('div');
    badgesLeft.className = 'photo-badges-left';

    if (typeof faceScore === 'number') {
      const scorePill = document.createElement('span');
      scorePill.className = 'face-score-pill';
      scorePill.textContent = `${Math.round(faceScore * 100)}%`;
      scorePill.title = 'Độ tương đồng khuôn mặt';
      badgesLeft.appendChild(scorePill);
    }

    const noteBadge = document.createElement('button');
    noteBadge.type = 'button';
    noteBadge.className = `note-badge-btn${hasNotes ? '' : ' hidden'}`;
    noteBadge.title = 'Xem / sửa ghi chú ảnh';
    noteBadge.innerHTML = `${ICONS.note}<span>Ghi chú</span>`;
    noteBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onOpenLightbox(index, true);
    });
    badgesLeft.appendChild(noteBadge);

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

    // Huy hiệu Bỏ chọn nhanh (hiển thị khi bật Chế độ chạm bỏ chọn nhanh)
    const quickBadge = document.createElement('div');
    quickBadge.className = 'quick-remove-badge';
    quickBadge.innerHTML = '<span>✕ Chạm để bỏ</span>';

    // Góc dưới: Tên file gọn & Nút Tải gốc (nếu download=1)
    const overlayBottom = document.createElement('div');
    overlayBottom.className = 'photo-overlay-bottom';

    const fileNameEl = document.createElement('span');
    fileNameEl.className = 'photo-filename';
    fileNameEl.textContent = photo.name;
    fileNameEl.title = photo.name;
    overlayBottom.appendChild(fileNameEl);

    if (this.callbacks.allowDownload) {
      const dlLink = document.createElement('a');
      dlLink.className = 'card-download-btn';
      dlLink.href = photo.downloadUrl;
      dlLink.target = '_blank';
      dlLink.rel = 'noopener noreferrer';
      dlLink.download = photo.name;
      dlLink.title = 'Tải ảnh gốc chất lượng cao';
      dlLink.setAttribute('aria-label', `Tải ảnh gốc ${photo.name}`);
      dlLink.innerHTML = ICONS.download;
      dlLink.addEventListener('click', (e) => e.stopPropagation());
      overlayBottom.appendChild(dlLink);
    }

    card.appendChild(imgWrap);
    card.appendChild(badgesLeft);
    card.appendChild(actions);
    card.appendChild(quickBadge);
    card.appendChild(overlayBottom);

    card.addEventListener('click', (e) => {
      // Nếu đang ở Chế độ chạm nhanh hoặc giữ phím Ctrl/Alt/Shift: chọn/bỏ chọn ngay tức khắc
      if ((this.callbacks.isQuickToggleMode && this.callbacks.isQuickToggleMode()) || e.ctrlKey || e.altKey || e.shiftKey) {
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

    const noteBadge = card.querySelector('.note-badge-btn');
    if (noteBadge) {
      noteBadge.classList.toggle('hidden', !this.hasNoteData(sel));
    }
  }
}
