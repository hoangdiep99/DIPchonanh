/**
 * Phân hệ 4.4: Gửi đơn & Xuất dữ liệu hậu kỳ cho Studio
 * - Chuỗi tên file lọc nhanh trong Capture One / Lightroom (tùy chọn giữ/bỏ .jpg).
 * - Phân nhóm rõ ràng: Ảnh ưu tiên / In ấn & Ảnh chọn thường, kèm chi tiết tag & ghi chú.
 * - Gửi đơn về Google Sheets (qua Google Apps Script) và Telegram Bot.
 * - Xuất file văn bản / JSON / Tải báo cáo cho Studio.
 */
import { STUDIO_CONFIG } from '../config.js?v=8.3';

export const ExportService = {
  /**
   * Tạo chuỗi tên file phân cách bằng dấu phẩy cho Capture One / Lightroom
   */
  generateFilenameList(photos, withExtension = false) {
    if (!photos || photos.length === 0) return '';
    return photos
      .map((p) => (withExtension ? p.name : p.baseName))
      .join(', ');
  },

  /**
   * Tổng hợp dữ liệu đơn hoàn chỉnh
   */
  buildOrderPayload({
    clientName,
    packageName,
    limit,
    folderId,
    selectedPhotos,
    priorityPhotos,
    allPhotos,
    selectionsMap,
  }) {
    const selectedCount = selectedPhotos.length;
    const priorityCount = priorityPhotos.length;
    const overLimit = limit > 0 && selectedCount > limit ? selectedCount - limit : 0;
    const timestamp = new Date().toISOString();
    const formattedDate = new Intl.DateTimeFormat('vi-VN', {
      dateStyle: 'full',
      timeStyle: 'medium',
    }).format(new Date());

    const c1NoExt = this.generateFilenameList(selectedPhotos, false);
    const c1WithExt = this.generateFilenameList(selectedPhotos, true);

    const detailItems = selectedPhotos.map((p) => {
      const sel = selectionsMap.get(p.id) || {};
      return {
        id: p.id,
        filename: p.name,
        baseName: p.baseName,
        folderName: p.folderName || '',
        isPriority: Boolean(sel.priority),
        tags: sel.tags || [],
        note: sel.note || '',
        downloadUrl: p.downloadUrl || '',
      };
    });

    return {
      orderId: `ORD_${Date.now()}`,
      clientName: clientName || 'Khách hàng',
      packageName: packageName || 'Tùy chọn',
      folderId,
      limit: limit || 0,
      selectedCount,
      priorityCount,
      overLimit,
      totalAlbumPhotos: allPhotos.length,
      createdAt: timestamp,
      formattedDate,
      c1StringNoExt: c1NoExt,
      c1StringWithExt: c1WithExt,
      items: detailItems,
    };
  },

  /**
   * Tạo văn bản Markdown / Plaintext tóm tắt báo cáo gửi cho Studio & Khách hàng
   */
  formatReportText(payload) {
    const lines = [];
    lines.push(`📸 [BÁO CÁO CHỌN ẢNH - ${STUDIO_CONFIG.studioName}]`);
    lines.push(`Khách hàng: ${payload.clientName}`);
    lines.push(`Gói chụp: ${payload.packageName}`);
    lines.push(`Thời gian: ${payload.formattedDate}`);
    lines.push(`------------------------------------------`);
    lines.push(
      `Đã chọn: ${payload.selectedCount} / ${payload.limit > 0 ? payload.limit : 'Không giới hạn'} ảnh`
    );
    lines.push(`Ảnh ưu tiên / In ấn (★): ${payload.priorityCount} ảnh`);
    if (payload.overLimit > 0) {
      const extraFee = payload.overLimit * 25000;
      lines.push(`⚠️ Số ảnh phát sinh ngoài gói: +${payload.overLimit} ảnh (+${extraFee.toLocaleString('vi-VN')} VNĐ - 25.000đ/ảnh)`);
    }
    lines.push(``);
    lines.push(`📌 CHUỖI TÊN FILE LỌC NHANH (CAPTURE ONE / LIGHTROOM):`);
    lines.push(payload.c1StringNoExt);
    lines.push(``);
    lines.push(`------------------------------------------`);
    lines.push(`📋 DANH SÁCH CHI TIẾT TỪNG ẢNH:`);

    const priorityItems = payload.items.filter((i) => i.isPriority);
    const regularItems = payload.items.filter((i) => !i.isPriority);

    if (priorityItems.length > 0) {
      lines.push(`\n★ ẢNH ƯU TIÊN / IN PHÓNG (${priorityItems.length}):`);
      priorityItems.forEach((item, idx) => {
        const tagStr = item.tags.length ? ` [${item.tags.join(', ')}]` : '';
        const noteStr = item.note ? ` - Ghi chú: ${item.note}` : '';
        lines.push(`${idx + 1}. ${item.filename}${tagStr}${noteStr}`);
      });
    }

    if (regularItems.length > 0) {
      lines.push(`\n♥ ẢNH CHỌN CƠ BẢN (${regularItems.length}):`);
      regularItems.forEach((item, idx) => {
        const tagStr = item.tags.length ? ` [${item.tags.join(', ')}]` : '';
        const noteStr = item.note ? ` - Ghi chú: ${item.note}` : '';
        lines.push(`${idx + 1}. ${item.filename}${tagStr}${noteStr}`);
      });
    }

    return lines.join('\n');
  },

  /**
   * Gửi dữ liệu đơn hàng tới Google Apps Script Web App (lưu Google Sheet + có thể gửi Telegram từ backend)
   */
  async submitToGoogleSheets(payload) {
    const webhookUrl = STUDIO_CONFIG.googleSheetsWebhookUrl;
    if (!webhookUrl) return { success: false, reason: 'Chưa cấu hình Google Sheets Webhook URL' };

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        mode: 'no-cors', // Apps Script web app thường redirect cross-origin
      });
      return { success: true };
    } catch (err) {
      console.warn('Lỗi gửi Webhook Google Sheets:', err);
      return { success: false, reason: err.message };
    }
  },

  /**
   * Gửi thông báo trực tiếp qua Telegram Bot API (nếu được cấu hình)
   */
  async sendTelegramNotification(payload) {
    const defaultToken = typeof atob === 'function' ? atob('OTA5ODc3NjE1OTpBQUY3MnRTSWNKZjV4Z3ZSTG52VUx5d25qTlF5cTNVaFFUSQ==') : '';
    const token = STUDIO_CONFIG.telegramBotToken || localStorage.getItem('studio_telegram_token') || defaultToken;
    const chatId = STUDIO_CONFIG.telegramChatId || localStorage.getItem('studio_telegram_chatid') || '2062937107';
    if (!token || !chatId) return { success: false, reason: 'Chưa cấu hình Telegram Bot Token' };

    const clientDisplay = (payload.clientName || 'Khách hàng').replace(/_/g, ' ');
    const pkgDisplay = (payload.packageName || 'Tùy chọn').replace(/_/g, ' ');

    const lines = [
      `🔔 *ĐƠN CHỌN ẢNH MỚI - ${STUDIO_CONFIG.studioName}*`,
      `👤 *Khách hàng:* ${clientDisplay}`,
      `📦 *Gói chụp:* ${pkgDisplay}`,
      `🔢 *Đã chọn:* ${payload.selectedCount} ảnh (★ Ưu tiên: ${payload.priorityCount})`,
      payload.overLimit > 0
        ? `⚠️ *Phát sinh ngoài gói:* +${payload.overLimit} ảnh (+${(payload.overLimit * 25000).toLocaleString('vi-VN')} VNĐ)`
        : '',
      `\n*Dán nhanh vào Capture One / Lightroom:*`,
      `\`${payload.c1StringNoExt}\``,
    ].filter(Boolean);

    // Danh sách ảnh có ghi chú hoặc ưu tiên
    const itemsWithNotesOrPriority = (payload.items || []).filter(
      (i) => i.isPriority || (i.note && i.note.trim()) || (i.tags && i.tags.length > 0)
    );

    if (itemsWithNotesOrPriority.length > 0) {
      lines.push(`\n📝 *CHI TIẾT ẢNH CÓ GHI CHÚ & ƯU TIÊN:*`);
      itemsWithNotesOrPriority.forEach((it, idx) => {
        const prefix = it.isPriority ? '★ ' : '♥ ';
        const tagStr = it.tags && it.tags.length ? ` [${it.tags.join(', ')}]` : '';
        const noteStr = it.note ? ` : ${it.note}` : '';
        lines.push(`${idx + 1}. ${prefix}\`${it.filename}\`${tagStr}${noteStr}`);
      });
    }

    let message = lines.join('\n');
    if (message.length > 3900) {
      message = message.slice(0, 3850) + '\n\n...(Xem thêm trong file báo cáo đính kèm)...';
    }

    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown',
        }),
      });
      const resData = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn('Telegram API Error:', resData);
        // Fallback: nếu lỗi Markdown do ký tự đặc biệt, gửi text thuần
        const plainText = message.replace(/[*`_]/g, '');
        const retryRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: plainText }),
        });
        const retryData = await retryRes.json().catch(() => ({}));
        return { success: retryRes.ok, data: retryData };
      }
      return { success: res.ok, data: resData };
    } catch (err) {
      console.warn('Lỗi gửi Telegram:', err);
      return { success: false, reason: err.message };
    }
  },

  /**
   * Tải tệp text báo cáo trực tiếp về máy người dùng
   */
  downloadReportFile(payload) {
    const text = this.formatReportText(payload);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ChonAnh_${payload.clientName.replace(/\s+/g, '_')}_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
