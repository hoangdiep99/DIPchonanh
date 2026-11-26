/**
 * Module theo dõi lượt xem album
 * - Gửi ping fire-and-forget đến Apps Script khi client mở album
 * - visitor_id duy nhất được lưu trong localStorage (1 thiết bị = 1 visitor)
 * - Nhận diện thiết bị từ userAgent: iPhone / Android / PC
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
 * Nhận diện loại thiết bị từ userAgent
 * @returns {'iPhone'|'Android'|'PC'}
 */
function detectDevice() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  return 'PC';
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
  const device = detectDevice();
  const timestamp = new Date().toISOString();

  const payload = {
    action: 'track_view',
    folderId,
    slug: slug || folderId,
    visitorId,
    device,
    timestamp,
  };

  // fire-and-forget: không block UI, không hiện lỗi cho user
  fetch(webhookUrl, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

/**
 * Lấy thống kê lượt xem của một album từ Apps Script
 * @param {string} webhookUrl
 * @param {string} slug
 * @param {string} folderId
 * @returns {Promise<{totalViews:number, uniqueVisitors:number, lastViewedAt:string|null, lastDevice:string|null, dailyViews:Array}>}
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
