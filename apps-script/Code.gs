/**
 * Google Apps Script (Code.gs)
 * Webhook 3-trong-1 Siêu Tốc & Đồng Bộ Đa Thiết Bị:
 * 1. doGet:
 *    - Đọc ảnh Google Drive (KHÔNG CẦN API KEY) + Siêu tốc với CacheService RAM (phản hồi trong 0.2s)
 *    - Đồng bộ đa thiết bị: Lấy dữ liệu chọn ảnh của album về cho mọi máy (action=get_sync)
 * 2. doPost:
 *    - Tiếp nhận đơn gửi về Google Sheets & Telegram Bot
 *    - Lưu bản nháp lựa chọn đa thiết bị từ điện thoại, máy tính, iPad lên đám mây (action=save_sync)
 * 
 * Hướng dẫn triển khai (Chỉ mất 1 phút):
 * 1. Mở https://script.google.com/ và mở dự án Web App của bạn.
 * 2. Dán đè toàn bộ nội dung file này vào Code.gs.
 * 3. Điền SPREADSHEET_ID ở dòng 26 (nếu dùng Google Sheet).
 * 4. Bấm "Triển khai" (Deploy) -> "Quản lý bản triển khai" (Manage deployments).
 * 5. Bấm vào biểu tượng cây bút (Chỉnh sửa) -> Chọn phiên bản: "Phiên bản mới" (New version) -> Bấm "Triển khai".
 */

// ID file Google Sheet lưu đơn (Lấy từ URL: https://docs.google.com/spreadsheets/d/<ID>/edit)
const SPREADSHEET_ID = '';

// Tùy chọn gửi thông báo Telegram (Đã được triển khai an toàn trong dự án Apps Script online của bạn)
const TELEGRAM_BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID = '2062937107';

/**
 * GET:
 * 1. Đọc danh sách file ảnh (có RAM cache 6 tiếng siêu tốc)
 * 2. Hoặc lấy bản nháp đồng bộ đa thiết bị (?action=get_sync&folderId=...)
 */
function doGet(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    var action = params.action || 'get_photos';
    var folderId = params.folderId || '';

    if (!folderId) {
      return jsonResponse({
        status: 'error',
        message: 'Thiếu tham số folderId'
      });
    }

    // 1. Phân hệ Đồng Bộ Đa Thiết Bị: Lấy bản nháp mới nhất từ đám mây
    if (action === 'get_sync') {
      var draftData = loadCloudDraft(folderId);
      return jsonResponse({
        status: 'success',
        folderId: folderId,
        draft: draftData.draft || {},
        updatedAt: draftData.updatedAt || 0,
        clientName: draftData.clientName || ''
      });
    }

    // 2. Phân hệ Đọc Ảnh Google Drive Siêu Tốc
    // Kiểm tra bộ nhớ tạm RAM (CacheService) để phản hồi trong ~0.1s
    var forceRefresh = params.refresh === '1';
    var cacheKey = 'folder_v2_' + folderId;
    if (!forceRefresh) {
      var cachedJson = getFromCache(cacheKey);
      if (cachedJson) {
        return ContentService.createTextOutput(cachedJson).setMimeType(ContentService.MimeType.JSON);
      }
    }

    var rootFolder = DriveApp.getFolderById(folderId);
    var subFolders = rootFolder.getFolders();
    var foldersList = [];
    var photosList = [];

    // Đọc ảnh trong thư mục gốc (Tối ưu: không gọi file.getSize() để tránh chậm)
    var rootFiles = rootFolder.getFiles();
    var rootPhotos = [];
    while (rootFiles.hasNext()) {
      var file = rootFiles.next();
      var name = file.getName();
      var mime = file.getMimeType();
      if (mime.indexOf('image/') === 0 || isImageExtension(name)) {
        rootPhotos.push({
          id: file.getId(),
          name: name,
          mimeType: mime || 'image/jpeg',
          folderId: folderId,
          folderName: 'Ảnh chung',
          thumbnailLink: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w800'
        });
      }
    }

    if (rootPhotos.length > 0) {
      foldersList.push({ id: folderId, name: 'Ảnh chung', count: rootPhotos.length });
      photosList = photosList.concat(rootPhotos);
    }

    // Đọc các thư mục phân cảnh con
    while (subFolders.hasNext()) {
      var sub = subFolders.next();
      var subFiles = sub.getFiles();
      var subPhotos = [];
      while (subFiles.hasNext()) {
        var sf = subFiles.next();
        var sfName = sf.getName();
        var smime = sf.getMimeType();
        if (smime.indexOf('image/') === 0 || isImageExtension(sfName)) {
          subPhotos.push({
            id: sf.getId(),
            name: sfName,
            mimeType: smime || 'image/jpeg',
            folderId: sub.getId(),
            folderName: sub.getName(),
            thumbnailLink: 'https://drive.google.com/thumbnail?id=' + sf.getId() + '&sz=w800'
          });
        }
      }
      if (subPhotos.length > 0) {
        foldersList.push({ id: sub.getId(), name: sub.getName(), count: subPhotos.length });
        photosList = photosList.concat(subPhotos);
      }
    }

    var output = {
      status: 'success',
      folders: foldersList,
      photos: photosList
    };

    var outputJson = JSON.stringify(output);
    // Lưu vào RAM Cache 6 tiếng (21600s) để tất cả các thiết bị sau đó mở lên tức thì
    putToCache(cacheKey, outputJson, 21600);

    return ContentService.createTextOutput(outputJson).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return jsonResponse({
      status: 'error',
      message: err.toString()
    });
  }
}

/**
 * POST: 
 * 1. Tiếp nhận đơn gửi về Google Sheets & Telegram
 * 2. Hoặc lưu bản nháp đồng bộ đa thiết bị (action=save_sync)
 */
function doPost(e) {
  try {
    var rawData = e.postData.contents;
    var data = JSON.parse(rawData);

    // 1. Phân hệ Lưu Nháp Đa Thiết Bị lên đám mây
    if (data.action === 'save_sync') {
      var folderId = data.folderId;
      if (!folderId) {
        return jsonResponse({ status: 'error', message: 'Thiếu folderId' });
      }
      saveCloudDraft(folderId, data.clientName || '', data.draft || {}, data.updatedAt || Date.now(), data.deviceName || '');
      return jsonResponse({ status: 'success', message: 'Đã lưu nháp đồng bộ đám mây' });
    }

    // 2. Tiếp nhận đơn hàng hoàn tất
    if (SPREADSHEET_ID) {
      saveToSheet(data);
    }

    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      sendTelegram(data);
    }

    return jsonResponse({ status: 'success' });
  } catch (error) {
    return jsonResponse({
      status: 'error',
      message: error.toString()
    });
  }
}

// --- CÁC HÀM TIỆN ÍCH HỖ TRỢ CACHE & ĐỒNG BỘ ---

function isImageExtension(name) {
  return /\.(jpe?g|png|webp|heic|tiff|bmp)$/i.test(name || '');
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * CacheService có giới hạn 100KB mỗi khóa, chia nhỏ (chunking) để cache an toàn tới hàng ngàn ảnh
 */
function getFromCache(key) {
  try {
    var cache = CacheService.getScriptCache();
    var countStr = cache.get(key + '_chunks');
    if (!countStr) return null;
    var count = parseInt(countStr, 10);
    var full = '';
    for (var i = 0; i < count; i++) {
      var part = cache.get(key + '_' + i);
      if (part === null) return null;
      full += part;
    }
    return full;
  } catch (e) {
    return null;
  }
}

function putToCache(key, fullText, ttlSeconds) {
  try {
    var cache = CacheService.getScriptCache();
    var chunkSize = 85000;
    var count = Math.ceil(fullText.length / chunkSize);
    if (count > 25) return; // Không vượt quá hạn mức script cache
    var map = {};
    map[key + '_chunks'] = String(count);
    for (var i = 0; i < count; i++) {
      map[key + '_' + i] = fullText.substring(i * chunkSize, (i + 1) * chunkSize);
    }
    cache.putAll(map, ttlSeconds || 21600);
  } catch (e) {
    // Bỏ qua lỗi cache nếu vượt hạn ngạch
  }
}

/**
 * Lưu bản nháp lựa chọn đa thiết bị vào Google Sheet tab 'Dong_Bo_Chon_Anh' hoặc file Drive
 */
function saveCloudDraft(folderId, clientName, draftObj, updatedAt, deviceName) {
  var jsonStr = JSON.stringify(draftObj);

  // Cách 1: Lưu vào tab 'Dong_Bo_Chon_Anh' trong Google Sheet nếu có SPREADSHEET_ID
  if (SPREADSHEET_ID) {
    try {
      var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      var sheet = ss.getSheetByName('Dong_Bo_Chon_Anh');
      if (!sheet) {
        sheet = ss.insertSheet('Dong_Bo_Chon_Anh');
        sheet.appendRow(['Folder ID', 'Khách hàng', 'Số ảnh đã chọn', 'JSON Dữ liệu', 'Thời gian cập nhật', 'Thiết bị']);
        sheet.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#E5E7EB');
      }

      var data = sheet.getDataRange().getValues();
      var rowIndex = -1;
      for (var i = 1; i < data.length; i++) {
        if (data[i][0] == folderId) {
          rowIndex = i + 1;
          break;
        }
      }

      var selectedCount = Object.keys(draftObj).filter(function(id) { return draftObj[id].selected; }).length;
      var updateTimeStr = new Date(updatedAt).toLocaleString('vi-VN');

      if (rowIndex > 0) {
        sheet.getRange(rowIndex, 2).setValue(clientName || '');
        sheet.getRange(rowIndex, 3).setValue(selectedCount);
        sheet.getRange(rowIndex, 4).setValue(jsonStr);
        sheet.getRange(rowIndex, 5).setValue(updateTimeStr);
        sheet.getRange(rowIndex, 6).setValue(deviceName || '');
      } else {
        sheet.appendRow([folderId, clientName || '', selectedCount, jsonStr, updateTimeStr, deviceName || '']);
      }
      return;
    } catch (sheetErr) {
      // Nếu không mở được Sheet, fallback sang lưu file trên Drive
    }
  }

  // Cách 2: Lưu vào file JSON trên Google Drive (hoàn toàn tự động, không cần tạo sheet)
  try {
    var fileName = '_studio_sync_' + folderId + '.json';
    var files = DriveApp.getFilesByName(fileName);
    var content = JSON.stringify({
      folderId: folderId,
      clientName: clientName,
      updatedAt: updatedAt,
      deviceName: deviceName,
      draft: draftObj
    });
    if (files.hasNext()) {
      var f = files.next();
      f.setContent(content);
    } else {
      DriveApp.createFile(fileName, content, MimeType.PLAIN_TEXT);
    }
  } catch (driveErr) {
    // ignore
  }
}

/**
 * Đọc bản nháp lựa chọn đa thiết bị từ Google Sheet hoặc file Drive
 */
function loadCloudDraft(folderId) {
  // Thử đọc từ Google Sheet trước
  if (SPREADSHEET_ID) {
    try {
      var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      var sheet = ss.getSheetByName('Dong_Bo_Chon_Anh');
      if (sheet) {
        var data = sheet.getDataRange().getValues();
        for (var i = 1; i < data.length; i++) {
          if (data[i][0] == folderId) {
            var rawJson = data[i][3];
            var parsed = JSON.parse(rawJson);
            return {
              draft: parsed,
              clientName: data[i][1],
              updatedAt: new Date(data[i][4]).getTime() || 0
            };
          }
        }
      }
    } catch (e) {
      // Fallback sang Drive file
    }
  }

  // Thử đọc từ Drive file
  try {
    var fileName = '_studio_sync_' + folderId + '.json';
    var files = DriveApp.getFilesByName(fileName);
    if (files.hasNext()) {
      var f = files.next();
      var content = f.getBlob().getDataAsString();
      var parsedData = JSON.parse(content);
      return {
        draft: parsedData.draft || {},
        clientName: parsedData.clientName || '',
        updatedAt: parsedData.updatedAt || 0
      };
    }
  } catch (e) {
    // Không có file
  }

  return { draft: {}, updatedAt: 0 };
}

function saveToSheet(data) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName('Đơn Chọn Ảnh');
  
  if (!sheet) {
    sheet = ss.insertSheet('Đơn Chọn Ảnh');
    sheet.appendRow([
      'Thời gian',
      'Mã đơn',
      'Khách hàng',
      'Gói chụp',
      'Định mức',
      'Đã chọn',
      'Ưu tiên (★)',
      'Phát sinh (+)',
      'Tên file lọc Capture One / Lightroom',
      'Chi tiết từng ảnh & ghi chú'
    ]);
    sheet.getRange(1, 1, 1, 10).setFontWeight('bold').setBackground('#F3F4F6');
  }

  var detailText = (data.items || []).map(function(item) {
    var tags = item.tags && item.tags.length ? ' [' + item.tags.join(', ') + ']' : '';
    var note = item.note ? ' (Ghi chú: ' + item.note + ')' : '';
    var star = item.isPriority ? '★ ' : '';
    return star + item.filename + tags + note;
  }).join('\n');

  sheet.appendRow([
    data.formattedDate || new Date().toLocaleString('vi-VN'),
    data.orderId || '',
    data.clientName || '',
    data.packageName || '',
    data.limit || 0,
    data.selectedCount || 0,
    data.priorityCount || 0,
    data.overLimit || 0,
    data.c1StringNoExt || '',
    detailText
  ]);
}

function sendTelegram(data) {
  var message = [
    '🔔 *ĐƠN CHỌN ẢNH MỚI*',
    '👤 *Khách hàng:* ' + data.clientName,
    '📦 *Gói chụp:* ' + data.packageName,
    '🔢 *Đã chọn:* ' + data.selectedCount + ' ảnh (★ Ưu tiên: ' + data.priorityCount + ')',
    (data.overLimit > 0 ? '⚠️ *Phát sinh:* +' + data.overLimit + ' ảnh' : ''),
    '\n*Danh sách Capture One:*',
    '`' + (data.c1StringNoExt || '') + '`'
  ].filter(Boolean).join('\n');

  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    }),
    muteHttpExceptions: true
  });
}

