/**
 * Module theo dõi lượt xem album
 * - Gửi ping fire-and-forget đến Apps Script khi client mở album
 * - visitor_id duy nhất được lưu trong localStorage (1 thiết bị = 1 visitor)
 * - Nhận diện thiết bị chi tiết (hệ điều hành, mã máy Android, trình duyệt / Zalo)
 * - Tra cứu vị trí tương đối theo IP (Tỉnh/Thành phố) qua HTTPS
 */

/**
 * Lấy hoặc tạo visitor_id duy nhất cho thiết bị này
 * @returns {string}
 */
function getVisitorId() {
  const KEY = 'dip_visitor_id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    localStorage.setItem(KEY, id);
  }
  return id;
}

/**
 * Nhận diện loại thiết bị cơ bản từ userAgent
 * @returns {'iPhone'|'Android'|'PC'}
 */
function detectDevice() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  return 'PC';
}

/**
 * Nhận diện trình duyệt hoặc app mở link (Zalo, Facebook, Safari, Chrome...)
 */
function detectBrowser(ua) {
  if (/Zalo/i.test(ua)) return 'Zalo';
  if (/FBAN|FBAV|Messenger/i.test(ua)) return 'Facebook';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/coc_coc_browser/i.test(ua)) return 'Cốc Cốc';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/CriOS|Chrome\//i.test(ua)) return 'Chrome';
  if (/FxiOS|Firefox\//i.test(ua)) return 'Firefox';
  if (/Safari\//i.test(ua)) return 'Safari';
  return '';
}

/**
 * Lấy tên thiết bị chi tiết (không cần xin quyền)
 * @returns {Promise<{device: 'iPhone'|'Android'|'PC', deviceDetail: string}>}
 */
async function getDeviceDetail() {
  const ua = navigator.userAgent || '';
  const device = detectDevice();
  const browser = detectBrowser(ua);

  try {
    // 1. Thử User-Agent Client Hints (Chrome/Edge/Android hiện đại cho biết mã máy)
    if (navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function') {
      const hints = await navigator.userAgentData.getHighEntropyValues(['model', 'platform']);
      const model = (hints.model || '').trim();
      const platform = (hints.platform || '').trim();
      if (device === 'Android' && model) {
        return { device, deviceDetail: [model, browser].filter(Boolean).join(' • ') };
      }
      if (device === 'PC' && platform) {
        return { device, deviceDetail: [platform, browser].filter(Boolean).join(' • ') };
      }
    }
  } catch (_) {}

  // 2. Fallback phân tích chuỗi User-Agent
  if (device === 'iPhone') {
    const isIpad = /iPad/i.test(ua);
    const iosMatch = ua.match(/OS (\d+)[._](\d+)/i);
    const osText = iosMatch ? `${isIpad ? 'iPadOS' : 'iOS'} ${iosMatch[1]}` : '';
    const base = isIpad ? 'iPad' : 'iPhone';
    const label = osText ? `${base} (${osText})` : base;
    return { device, deviceDetail: [label, browser].filter(Boolean).join(' • ') };
  }

  if (device === 'Android') {
    const modelMatch = ua.match(/Android\s+[\d.]+;\s*([^;)]+?)\s*(?:Build\/|\))/i);
    const rawModel = modelMatch ? modelMatch[1].trim() : '';
    const cleanModel = rawModel && rawModel.toLowerCase() !== 'k' ? rawModel : 'Android';
    return { device, deviceDetail: [cleanModel, browser].filter(Boolean).join(' • ') };
  }

  let osName = 'PC';
  if (/Windows NT 10/i.test(ua)) osName = 'Windows';
  else if (/Mac OS X/i.test(ua)) osName = 'macOS';
  else if (/Linux/i.test(ua)) osName = 'Linux';
  return { device, deviceDetail: [osName, browser].filter(Boolean).join(' • ') };
}

/**
 * Tra cứu vị trí tương đối theo IP (Tỉnh/Thành phố), timeout 1.5s để không ảnh hưởng trải nghiệm
 * @returns {Promise<string>}
 */
async function getGeoLocation() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch('https://ipwho.is/?fields=success,city,region,country_code', {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return '';
    const data = await res.json();
    if (!data || data.success === false) return '';
    const city = (data.city || data.region || '').trim();
    const cc = (data.country_code || '').trim();
    return [city, cc].filter(Boolean).join(', ');
  } catch (_) {
    clearTimeout(timer);
    return '';
  }
}

/**
 * Gửi ping theo dõi lượt xem album lên Apps Script (fire-and-forget)
 * @param {string} webhookUrl - URL Google Apps Script webhook
 * @param {string} folderId   - Google Drive folder ID của album
 * @param {string} slug       - Slug ngắn của album (dùng làm key lưu trữ)
 */
export function trackAlbumView(webhookUrl, folderId, slug) {
  if (!webhookUrl || !folderId) return;

  const visitorId = getVisitorId();
  const timestamp = new Date().toISOString();

  // Chạy bất đồng bộ hoàn toàn ở nền để không bao giờ chặn UI
  Promise.all([getDeviceDetail(), getGeoLocation()])
    .then(([devInfo, location]) => {
      const payload = {
        action: 'track_view',
        folderId,
        slug: slug || folderId,
        visitorId,
        device: devInfo.device,
        deviceDetail: devInfo.deviceDetail,
        location,
        timestamp,
      };

      return fetch(webhookUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
      });
    })
    .catch(() => {});
}

/**
 * Lấy thống kê lượt xem của một album từ Apps Script
 * @param {string} webhookUrl
 * @param {string} slug
 * @param {string} folderId
 * @returns {Promise<Object|null>}
 */
export async function getAlbumViewStats(webhookUrl, slug, folderId) {
  if (!webhookUrl) return null;
  try {
    const params = new URLSearchParams({
      action: 'get_views',
      slug: slug || folderId,
      folderId: folderId || '',
    });
    const res = await fetch(`${webhookUrl}?${params.toString()}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.status === 'success') return json.stats;
  } catch (_) {}
  return null;
}
