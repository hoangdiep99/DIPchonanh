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
const TELEGRAM_BOT_TOKEN = '9098776159:AAF72tSIcJf5xgvRLnvULywnjNQyq3UhQTI';
const TELEGRAM_CHAT_ID = '2062937107';

// Tài khoản & Mật khẩu Admin mặc định (Lưu bí mật trên máy chủ Google, người ngoài không thể xem)
// Khi bạn bấm "Đổi mật khẩu" trong #admin, mật khẩu mới sẽ được lưu vào PropertiesService của Google
const DEFAULT_ADMIN_USER = 'admin';
const DEFAULT_ADMIN_PASS = 'CHANGE_ME_2026';

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

    // 0. Phân hệ Tra Cứu Link Ngắn Theo Tên Khách (?k=slug)
    if (action === 'get_album') {
      var slug = (params.slug || '').toLowerCase().trim();
      var raw = PropertiesService.getScriptProperties().getProperty('album_' + slug);
      if (raw) {
        return jsonResponse({
          status: 'success',
          album: JSON.parse(raw)
        });
      }

      // Tìm tiếp trong danh sách album admin đã đồng bộ lên Google Drive
      var historyData = loadCloudAdminHistory();
      if (Array.isArray(historyData)) {
        for (var h = 0; h < historyData.length; h++) {
          var item = historyData[h];
          if (item && item.slug && item.slug.toLowerCase().trim() === slug) {
            return jsonResponse({
              status: 'success',
              album: item
            });
          }
        }
      }

      return jsonResponse({
        status: 'not_found',
        message: 'Chưa có album cho mã này'
      });
    }

    // 0.1. Phân hệ Đồng Bộ Cụm Khuôn Mặt Đám Mây (?action=get_clusters&slug=...)
    if (action === 'get_clusters') {
      var slugKey = (params.slug || '').toLowerCase().trim();
      var cloudClusters = loadCloudClusters(slugKey, folderId);
      if (cloudClusters && Array.isArray(cloudClusters) && cloudClusters.length > 0) {
        return jsonResponse({
          status: 'success',
          clusters: cloudClusters
        });
      }
      return jsonResponse({
        status: 'not_found',
        message: 'Chưa có dữ liệu khuôn mặt'
      });
    }

    // 0.1b. Phân hệ Đồng Bộ Đánh Giá Chất Lượng AI Đám Mây (?action=get_quality&slug=...)

    // Lấy ảnh bìa album từ cloud (?action=get_cover&slug=...&folderId=...)
    if (action === 'get_cover') {
      var coverSlug = (params.slug || folderId || '').toLowerCase().trim();
      var coverData = loadCloudCover(coverSlug);
      if (coverData) {
        return jsonResponse({ status: 'success', cover: coverData });
      }
      return jsonResponse({ status: 'not_found', cover: null });
    }

    // Lấy thống kê lượt xem album (?action=get_views&slug=...&folderId=...)
    if (action === 'get_views') {
      var viewSlug = (params.slug || folderId || '').toLowerCase().trim();
      var viewLog = loadViewLog(viewSlug);
      var stats = computeViewStats(viewLog);
      return jsonResponse({ status: 'success', stats: stats });
    }

    if (action === 'get_quality') {
      var slugQ = (params.slug || '').toLowerCase().trim();
      var cloudQuality = loadCloudQuality(slugQ, folderId);
      if (cloudQuality && typeof cloudQuality === 'object') {
        return jsonResponse({
          status: 'success',
          quality: cloudQuality
        });
      }
      return jsonResponse({
        status: 'not_found',
        message: 'Chưa có dữ liệu chất lượng ảnh'
      });
    }

    // 0.2. Phân hệ Đồng Bộ Danh Sách Album Cho Admin Đa Thiết Bị (?action=get_admin_history)
    // Danh sách album công khai cho Trang chủ (chỉ trả các album isPublic !== false)
    if (action === 'get_public_albums') {
      var allHist = loadCloudAdminHistory() || [];
      var publicList = [];
      for (var pIdx = 0; pIdx < allHist.length; pIdx++) {
        var pubItem = allHist[pIdx];
        if (pubItem && pubItem.isPublic !== false && !pubItem.__deleted && !pubItem._deleted && !pubItem.deleted && pubItem.client) {
          publicList.push({
            folderId: pubItem.folderId,
            client: pubItem.client,
            pkg: pubItem.pkg,
            slug: pubItem.slug,
            limit: pubItem.limit,
            download: pubItem.download,
            time: pubItem.time,
            shortUrl: pubItem.shortUrl,
            link: pubItem.link,
            coverUrl: pubItem.coverUrl || '',
            isPublic: true
          });
        }
      }
      return jsonResponse({ status: 'success', history: publicList });
    }

    if (action === 'get_admin_history') {
      if (!isValidAdminToken(params.adminToken)) {
        return jsonResponse({ status: 'unauthorized', message: 'Yêu cầu đăng nhập Admin' });
      }
      var historyData = loadCloudAdminHistory();
      return jsonResponse({
        status: 'success',
        history: historyData || []
      });
    }

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

    // 0. Phân hệ Lưu Danh Bạ Album Cho Link Ngắn (?k=slug)
    if (data.action === 'save_album') {
      if (!isValidAdminToken(data.adminToken)) {
        return jsonResponse({ status: 'unauthorized', message: 'Yêu cầu đăng nhập Admin' });
      }
      var slug = (data.slug || '').toLowerCase().trim();
      var albumData = data.albumData || {};
      if (slug && albumData.folderId) {
        PropertiesService.getScriptProperties().setProperty('album_' + slug, JSON.stringify(albumData));
        return jsonResponse({ status: 'success', message: 'Đã lưu danh bạ album cho slug: ' + slug });
      }
    }

    // 0.1. Phân hệ Lưu Cụm Khuôn Mặt Đám Mây (action=save_clusters)
    if (data.action === 'save_clusters') {
      if (!isValidAdminToken(data.adminToken)) {
        return jsonResponse({ status: 'unauthorized', message: 'Yêu cầu đăng nhập Admin' });
      }
      var slugCluster = (data.slug || '').toLowerCase().trim();
      var folderIdCluster = data.folderId || '';
      var clustersList = data.clusters || [];
      if ((slugCluster || folderIdCluster) && Array.isArray(clustersList) && clustersList.length > 0) {
        saveCloudClusters(slugCluster, folderIdCluster, clustersList);
        return jsonResponse({ status: 'success', message: 'Đã lưu cụm khuôn mặt lên đám mây' });
      }
    }

    // 0.1b. Phân hệ Lưu Đánh Giá Chất Lượng AI Đám Mây (action=save_quality)

    // Lưu ảnh bìa album lên cloud (action=save_cover)
    if (data.action === 'save_cover') {
      if (!isValidAdminToken(data.adminToken)) {
        return jsonResponse({ status: 'unauthorized', message: 'Yêu cầu đăng nhập Admin' });
      }
      var coverSlug2 = (data.slug || data.folderId || '').toLowerCase().trim();
      if (coverSlug2) {
        saveCloudCover(coverSlug2, {
          coverUrl: data.coverUrl || '',
          coverId: data.coverId || '',
          folderId: data.folderId || '',
          updatedAt: new Date().toISOString()
        });
      }
      return jsonResponse({ status: 'ok' });
    }

    // Ghi nhận lượt xem album (action=track_view)
    if (data.action === 'track_view') {
      var trackSlug = (data.slug || data.folderId || '').toLowerCase().trim();
      if (trackSlug) {
        var log = loadViewLog(trackSlug);
        log.visits = log.visits || [];
        log.visits.push({
          ts: data.timestamp || new Date().toISOString(),
          visitorId: data.visitorId || '',
          device: data.device || 'PC',
          deviceDetail: data.deviceDetail || '',
          location: data.location || '',
          folderId: data.folderId || ''
        });
        // Giữ tối đa 500 lượt gần nhất
        if (log.visits.length > 500) {
          log.visits = log.visits.slice(log.visits.length - 500);
        }
        saveViewLog(trackSlug, log);
      }
      return jsonResponse({ status: 'ok' });
    }

    if (data.action === 'save_quality') {
      if (!isValidAdminToken(data.adminToken)) {
        return jsonResponse({ status: 'unauthorized', message: 'Yêu cầu đăng nhập Admin' });
      }
      var slugQuality = (data.slug || '').toLowerCase().trim();
      var folderIdQuality = data.folderId || '';
      var qualityMap = data.quality || {};
      if ((slugQuality || folderIdQuality) && typeof qualityMap === 'object' && Object.keys(qualityMap).length > 0) {
        saveCloudQuality(slugQuality, folderIdQuality, qualityMap);
        return jsonResponse({ status: 'success', message: 'Đã lưu chất lượng ảnh AI lên đám mây' });
      }
    }

    // 0.2. Phân hệ Lưu Danh Sách Album Admin Đa Thiết Bị (action=save_admin_history)
    if (data.action === 'save_admin_history') {
      if (!isValidAdminToken(data.adminToken)) {
        return jsonResponse({ status: 'unauthorized', message: 'Yêu cầu đăng nhập Admin' });
      }
      var historyList = data.history || [];
      if (Array.isArray(historyList)) {
        saveCloudAdminHistory(historyList);
        return jsonResponse({ status: 'success', message: 'Đã lưu lịch sử album admin lên đám mây' });
      }
    }

    // 0.3. Phân hệ Xác Thực Đăng Nhập Admin Bí Mật Trên Máy Chủ Google (action=admin_login)
    if (data.action === 'admin_login') {
      var inputPass = (data.password || '').toString().trim();
      var props = PropertiesService.getScriptProperties();
      var savedPass = props.getProperty('studio_admin_pass') || DEFAULT_ADMIN_PASS;

      if (inputPass && inputPass === savedPass) {
        return jsonResponse({ status: 'success', authenticated: true, adminToken: getOrCreateAdminToken() });
      }
      return jsonResponse({ status: 'error', authenticated: false, message: 'Mật khẩu không chính xác!' });
    }

    // 0.4. Phân hệ Đổi Mật Khẩu Admin Đồng Bộ Mọi Thiết Bị (action=admin_change_pass)
    if (data.action === 'admin_change_pass') {
      var oldPass = (data.oldPassword || '').toString().trim();
      var newPass = (data.newPassword || '').toString().trim();
      var propsAuth = PropertiesService.getScriptProperties();
      var currentPass = propsAuth.getProperty('studio_admin_pass') || DEFAULT_ADMIN_PASS;

      if (!oldPass || oldPass !== currentPass) {
        return jsonResponse({ status: 'error', message: 'Mật khẩu hiện tại không đúng!' });
      }
      if (!newPass || newPass.length < 4) {
        return jsonResponse({ status: 'error', message: 'Mật khẩu mới phải có ít nhất 4 ký tự!' });
      }
      propsAuth.setProperty('studio_admin_pass', newPass);
      var rotatedToken = rotateAdminToken();
      return jsonResponse({ status: 'success', message: 'Đã đổi mật khẩu Studio trên Đám mây thành công!', adminToken: rotatedToken });
    }

    // 0.5. Phân hệ Quên Mật Khẩu -> Gửi mật khẩu hiện tại về riêng Telegram chủ Studio (action=admin_forgot_pass)
    if (data.action === 'admin_forgot_pass') {
      var forgotCache = CacheService.getScriptCache();
      if (forgotCache.get('forgot_pass_cooldown')) {
        return jsonResponse({ status: 'error', message: 'Vui lòng đợi 5 phút trước khi yêu cầu gửi lại mật khẩu.' });
      }
      forgotCache.put('forgot_pass_cooldown', '1', 300);
      if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN' || !TELEGRAM_CHAT_ID) {
        return jsonResponse({
          status: 'error',
          message: 'Chưa cấu hình TELEGRAM_BOT_TOKEN trong Code.gs! Bạn có thể xem mật khẩu trong Cài đặt dự án (⚙️) > Thuộc tính tập lệnh.'
        });
      }
      var propsForgot = PropertiesService.getScriptProperties();
      var curUser = propsForgot.getProperty('studio_admin_user') || DEFAULT_ADMIN_USER;
      var curPass = propsForgot.getProperty('studio_admin_pass') || DEFAULT_ADMIN_PASS;
      var nowStr = Utilities.formatDate(new Date(), 'GMT+7', 'HH:mm:ss dd/MM/yyyy');
      var tgText =
        '🔐 *KHÔI PHỤC MẬT KHẨU ADMIN — DIPchonanh*\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        '👤 Tài khoản: `' + curUser + '`\n' +
        '🔑 Mật khẩu hiện tại: `' + curPass + '`\n' +
        '🕒 Thời gian yêu cầu: ' + nowStr + '\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        '⚠️ Nếu không phải bạn yêu cầu, hãy đăng nhập và đổi mật khẩu ngay.';

      try {
        var tgUrl = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
        var tgRes = UrlFetchApp.fetch(tgUrl, {
          method: 'post',
          contentType: 'application/json',
          muteHttpExceptions: true,
          payload: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: tgText,
            parse_mode: 'Markdown'
          })
        });
        var tgJson = JSON.parse(tgRes.getContentText() || '{}');
        if (tgJson && tgJson.ok) {
          return jsonResponse({ status: 'success', message: '✅ Đã gửi mật khẩu về Telegram của chủ Studio!' });
        }
        return jsonResponse({ status: 'error', message: 'Telegram từ chối gửi tin: ' + (tgJson.description || 'Kiểm tra lại TELEGRAM_BOT_TOKEN') });
      } catch (tgErr) {
        return jsonResponse({ status: 'error', message: 'Lỗi gửi Telegram: ' + tgErr.toString() });
      }
    }

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

/**
 * Lưu cụm khuôn mặt vào RAM cache và file trên Google Drive (không giới hạn 9KB)
 */
function saveCloudClusters(slug, folderId, clusters) {
  var key = 'clusters_' + (slug || folderId);
  var jsonStr = JSON.stringify(clusters);
  
  // 1. Lưu vào RAM Cache 6 tiếng để phản hồi tức thì ~0.1s
  putToCache(key, jsonStr, 21600);

  // 2. Lưu vào file JSON trên Google Drive (vĩnh viễn)
  try {
    var fileName = '_studio_faces_' + (slug || folderId) + '.json';
    var files = DriveApp.getFilesByName(fileName);
    if (files.hasNext()) {
      var f = files.next();
      f.setContent(jsonStr);
    } else {
      DriveApp.createFile(fileName, jsonStr, MimeType.PLAIN_TEXT);
    }
  } catch (e) {
    // ignore
  }
}

/**
 * Đọc cụm khuôn mặt từ RAM cache hoặc file trên Google Drive
 */
function loadCloudClusters(slug, folderId) {
  var key = 'clusters_' + (slug || folderId);
  // 1. Thử lấy từ RAM Cache
  var cached = getFromCache(key);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {}
  }

  // 2. Thử lấy từ Google Drive file
  try {
    var fileName = '_studio_faces_' + (slug || folderId) + '.json';
    var files = DriveApp.getFilesByName(fileName);
    if (files.hasNext()) {
      var content = files.next().getBlob().getDataAsString();
      if (content) {
        putToCache(key, content, 21600);
        return JSON.parse(content);
      }
    }
  } catch (e) {}

  return null;
}

/**
 * Lưu đánh giá chất lượng ảnh AI (mờ, nhắm mắt, giống nhau) lên RAM Cache và file Google Drive
 */
function saveCloudQuality(slug, folderId, qualityMap) {
  var key = 'quality_' + (slug || folderId);
  var jsonStr = JSON.stringify(qualityMap);
  putToCache(key, jsonStr, 21600);
  try {
    var fileName = '_studio_quality_' + (slug || folderId) + '.json';
    var files = DriveApp.getFilesByName(fileName);
    if (files.hasNext()) {
      var f = files.next();
      f.setContent(jsonStr);
    } else {
      DriveApp.createFile(fileName, jsonStr, MimeType.PLAIN_TEXT);
    }
  } catch (e) {}
}

/**
 * Đọc đánh giá chất lượng ảnh AI từ RAM Cache hoặc Google Drive
 */
function loadCloudQuality(slug, folderId) {
  var key = 'quality_' + (slug || folderId);
  var cached = getFromCache(key);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {}
  }
  try {
    var fileName = '_studio_quality_' + (slug || folderId) + '.json';
    var files = DriveApp.getFilesByName(fileName);
    if (files.hasNext()) {
      var content = files.next().getBlob().getDataAsString();
      if (content) {
        putToCache(key, content, 21600);
        return JSON.parse(content);
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Lưu danh sách album admin vào RAM cache và Google Drive để đồng bộ máy tính & điện thoại
 */
function saveCloudAdminHistory(historyList) {
  var key = 'admin_history';
  var jsonStr = JSON.stringify(historyList);
  putToCache(key, jsonStr, 21600);
  try {
    var fileName = '_studio_admin_history.json';
    var files = DriveApp.getFilesByName(fileName);
    if (files.hasNext()) {
      var f = files.next();
      f.setContent(jsonStr);
    } else {
      DriveApp.createFile(fileName, jsonStr, MimeType.PLAIN_TEXT);
    }
  } catch (e) {}
}

/**
 * Đọc danh sách album admin từ RAM cache hoặc Google Drive
 */
function loadCloudAdminHistory() {
  var key = 'admin_history';
  var cached = getFromCache(key);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {}
  }
  try {
    var fileName = '_studio_admin_history.json';
    var files = DriveApp.getFilesByName(fileName);
    if (files.hasNext()) {
      var content = files.next().getBlob().getDataAsString();
      if (content) {
        putToCache(key, content, 21600);
        return JSON.parse(content);
      }
    }
  } catch (e) {}
  return [];
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

// ============================================================
// Helper: Ảnh bìa album (save/load)
// ============================================================

/**
 * Lưu ảnh bìa album lên Google Drive
 */
function saveCloudCover(slug, coverData) {
  try {
    var fileName = '_studio_cover_' + slug + '.json';
    var jsonStr = JSON.stringify(coverData);
    var files = DriveApp.getFilesByName(fileName);
    if (files.hasNext()) {
      files.next().setContent(jsonStr);
    } else {
      DriveApp.createFile(fileName, jsonStr, MimeType.PLAIN_TEXT);
    }
  } catch (e) {}
}

/**
 * Đọc ảnh bìa album từ Google Drive
 */
function loadCloudCover(slug) {
  try {
    var fileName = '_studio_cover_' + slug + '.json';
    var files = DriveApp.getFilesByName(fileName);
    if (files.hasNext()) {
      var content = files.next().getBlob().getDataAsString();
      if (content) return JSON.parse(content);
    }
  } catch (e) {}
  return null;
}

// ============================================================
// Helper: Theo dõi lượt xem album (save/load/compute)
// ============================================================

/**
 * Lưu log lượt xem lên Google Drive
 */
function saveViewLog(slug, log) {
  try {
    var fileName = '_studio_views_' + slug + '.json';
    var jsonStr = JSON.stringify(log);
    var files = DriveApp.getFilesByName(fileName);
    if (files.hasNext()) {
      files.next().setContent(jsonStr);
    } else {
      DriveApp.createFile(fileName, jsonStr, MimeType.PLAIN_TEXT);
    }
  } catch (e) {}
}

/**
 * Đọc log lượt xem từ Google Drive
 */
function loadViewLog(slug) {
  try {
    var fileName = '_studio_views_' + slug + '.json';
    var files = DriveApp.getFilesByName(fileName);
    if (files.hasNext()) {
      var content = files.next().getBlob().getDataAsString();
      if (content) return JSON.parse(content);
    }
  } catch (e) {}
  return { visits: [] };
}

/**
 * Tính thống kê từ log lượt xem
 * @returns {{totalViews, uniqueVisitors, lastViewedAt, lastDevice, dailyViews}}
 */
function computeViewStats(log) {
  var visits = (log && log.visits) ? log.visits : [];
  var totalViews = visits.length;
  var visitorSet = {};
  var lastVisit = null;
  var dailyMap = {};
  var deviceMap = { iPhone: 0, Android: 0, PC: 0 };
  var locationMap = {};

  for (var i = 0; i < visits.length; i++) {
    var v = visits[i];
    if (v.visitorId) visitorSet[v.visitorId] = true;
    if (!lastVisit || v.ts > lastVisit.ts) lastVisit = v;
    var day = (v.ts || '').slice(0, 10); // YYYY-MM-DD
    if (day) dailyMap[day] = (dailyMap[day] || 0) + 1;
    var dev = v.device || 'PC';
    deviceMap[dev] = (deviceMap[dev] || 0) + 1;
    if (v.location) {
      locationMap[v.location] = (locationMap[v.location] || 0) + 1;
    }
  }

  var dailyViews = Object.keys(dailyMap).sort().map(function(d) {
    return { date: d, count: dailyMap[d] };
  });

  var locations = Object.keys(locationMap).map(function(loc) {
    return { name: loc, count: locationMap[loc] };
  }).sort(function(a, b) { return b.count - a.count; });

  var recentVisits = visits.slice(-10).reverse().map(function(v) {
    return {
      ts: v.ts,
      device: v.device || 'PC',
      deviceDetail: v.deviceDetail || '',
      location: v.location || ''
    };
  });

  return {
    totalViews: totalViews,
    uniqueVisitors: Object.keys(visitorSet).length,
    lastViewedAt: lastVisit ? lastVisit.ts : null,
    lastDevice: lastVisit ? lastVisit.device : null,
    lastDeviceDetail: lastVisit ? (lastVisit.deviceDetail || '') : '',
    lastLocation: lastVisit ? (lastVisit.location || '') : '',
    dailyViews: dailyViews,
    devices: deviceMap,
    locations: locations,
    recentVisits: recentVisits
  };
}

// ============================================================
// Helper: Quản lý Admin Token bí mật trên ScriptProperties
// ============================================================
function getOrCreateAdminToken() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('studio_admin_token');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('studio_admin_token', token);
  }
  return token;
}

function rotateAdminToken() {
  var props = PropertiesService.getScriptProperties();
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty('studio_admin_token', token);
  return token;
}

function isValidAdminToken(token) {
  if (!token) return false;
  var expected = getOrCreateAdminToken();
  return String(token) === String(expected);
}
