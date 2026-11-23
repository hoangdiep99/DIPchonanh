/**
 * Phân hệ 4.1: Duyệt & Tối ưu tải ảnh Google Drive API v3 (3 cấp độ) + Demo Dataset.
 */

import { STUDIO_CONFIG } from '../config.js?v=8.5';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';
const SUPPORTED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Tạo danh sách URL thumbnail theo 3 cấp độ Progressive Loading:
 *  - Cấp 1 (AI scan): sz=w400
 *  - Cấp 2 (Lưới hiển thị): sz=w800
 *  - Cấp 3 (Xem lớn & Tải gốc): sz=w2048 & export=download
 */
export function buildDriveUrls(file) {
  const id = file.id;
  const rawThumb = file.thumbnailLink || '';
  const resizedThumb = (width) =>
    rawThumb ? rawThumb.replace(/=s\d+(-[a-z0-9-]+)?$/i, `=w${width}`) : '';

  return {
    // Cấp 1: Quét AI (ưu tiên lh3 trực tiếp để hỗ trợ CORS canvas mượt hơn, có fallback)
    aiUrl: `https://lh3.googleusercontent.com/d/${id}=w400`,
    aiFallbacks: [
      resizedThumb(400),
      `https://drive.google.com/thumbnail?id=${id}&sz=w400`,
    ].filter(Boolean),

    // Cấp 2: Lưới hiển thị (sz=w800)
    gridUrl: `https://drive.google.com/thumbnail?id=${id}&sz=w800`,
    gridFallbacks: [
      `https://lh3.googleusercontent.com/d/${id}=w800`,
      resizedThumb(800),
    ].filter(Boolean),

    // Cấp 3: Lightbox xem nhanh (sz=w2560 - sắc nét hơn w2048)
    lightboxUrl: `https://lh3.googleusercontent.com/d/${id}=w2560`,
    lightboxFallbacks: [
      `https://drive.google.com/thumbnail?id=${id}&sz=w2048`,
      `https://lh3.googleusercontent.com/d/${id}=w2048`,
      resizedThumb(2048),
      `https://drive.google.com/thumbnail?id=${id}&sz=w1600`,
    ].filter(Boolean),

    // Cấp 4: Ảnh gốc nguyên bản siêu nét (Original Sensor Resolution = s0) khi Zoom soi nét
    originalUrl: `https://lh3.googleusercontent.com/d/${id}=s0`,
    originalFallbacks: [
      `https://lh3.googleusercontent.com/d/${id}=w3840`, // 4K UHD
      `https://drive.google.com/uc?export=view&id=${id}`,
      `https://lh3.googleusercontent.com/d/${id}=w2560`,
    ].filter(Boolean),

    downloadUrl: `https://drive.google.com/uc?export=download&id=${id}`,
  };
}

/**
 * Chuẩn hóa tỷ lệ khung hình thật từ imageMediaMetadata (có xử lý EXIF rotation 90/270).
 */
function resolveDimensions(meta) {
  let width = Number(meta?.width) || 0;
  let height = Number(meta?.height) || 0;
  const rotation = Number(meta?.rotation) || 0;
  if (rotation === 90 || rotation === 270) {
    [width, height] = [height, width];
  }
  if (!width || !height) {
    return { width: 1200, height: 800, aspectRatio: 1.5, hasExactSize: false };
  }
  return {
    width,
    height,
    aspectRatio: width / height,
    hasExactSize: true,
  };
}

/**
 * Truy vấn toàn bộ con trực tiếp của một thư mục Google Drive (tự xử lý phân trang nextPageToken).
 */
async function listFolderChildren(folderId, apiKey) {
  const items = [];
  let pageToken = '';

  const fields =
    'nextPageToken,files(id,name,mimeType,thumbnailLink,size,createdTime,imageMediaMetadata(width,height,rotation))';
  const q = `'${folderId}' in parents and trashed = false`;

  do {
    const params = new URLSearchParams({
      q,
      fields,
      pageSize: '1000',
      orderBy: 'folder,name',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
      key: apiKey,
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${DRIVE_API_BASE}?${params.toString()}`);
    if (!res.ok) {
      let detail = '';
      try {
        const errJson = await res.json();
        detail = errJson?.error?.message || '';
      } catch {
        // ignore JSON parse error
      }
      const err = new Error(
        detail || `Không thể truy cập Google Drive (HTTP ${res.status}).`
      );
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    if (Array.isArray(data.files)) {
      items.push(...data.files);
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return items;
}

/**
 * Biến đổi bản ghi file Drive thành đối tượng ảnh chuẩn của ứng dụng.
 */
function normalizeDrivePhoto(file, folderId, folderName) {
  const urls = buildDriveUrls(file);
  const dims = resolveDimensions(file.imageMediaMetadata);
  return {
    id: file.id,
    name: file.name,
    baseName: stripExtension(file.name),
    mimeType: file.mimeType,
    size: Number(file.size) || 0,
    folderId,
    folderName,
    width: dims.width,
    height: dims.height,
    aspectRatio: dims.aspectRatio,
    hasExactSize: dims.hasExactSize,
    ...urls,
  };
}

export function stripExtension(filename) {
  if (!filename) return '';
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(0, idx) : filename;
}

/**
 * Sắp xếp tự nhiên tên file (DSC_0002 đứng trước DSC_0010).
 */
const naturalCollator = new Intl.Collator('vi', {
  numeric: true,
  sensitivity: 'base',
});

/**
 * Tải toàn bộ ảnh từ thư mục Google Drive gốc và các thư mục phân cảnh con (tối đa 2 cấp để nhanh).
 * @returns {Promise<{ folders: Array<{id, name, count}>, photos: Array }>}
 */
const ALBUM_CACHE_PREFIX = 'studio_album_cache_';

export function getCachedAlbum(rootFolderId) {
  try {
    const raw = localStorage.getItem(`${ALBUM_CACHE_PREFIX}${rootFolderId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.photos) || parsed.photos.length === 0) return null;
    // Tái tạo lại các URL và thuộc tính cho từng ảnh từ cache
    const photos = parsed.photos.map((p) => {
      const urls = buildDriveUrls(p);
      return {
        ...p,
        ...urls,
      };
    });
    return {
      folders: parsed.folders || [],
      photos,
      isFromCache: true,
      cachedAt: parsed.cachedAt || 0,
    };
  } catch (e) {
    return null;
  }
}

export function setCachedAlbum(rootFolderId, result) {
  try {
    if (!result || !result.photos || !result.photos.length) return;
    const payload = {
      cachedAt: Date.now(),
      folders: result.folders || [],
      photos: result.photos.map((p) => ({
        id: p.id,
        name: p.name,
        baseName: p.baseName || stripExtension(p.name),
        mimeType: p.mimeType,
        size: p.size || 0,
        folderId: p.folderId,
        folderName: p.folderName,
        width: p.width || 1200,
        height: p.height || 800,
        aspectRatio: p.aspectRatio || 1.5,
        thumbnailLink: p.thumbnailLink || '',
      })),
    };
    localStorage.setItem(`${ALBUM_CACHE_PREFIX}${rootFolderId}`, JSON.stringify(payload));
  } catch (e) {
    // QuotaExceeded hoặc Private mode
  }
}

export function clearAlbumCache(rootFolderId) {
  try {
    localStorage.removeItem(`${ALBUM_CACHE_PREFIX}${rootFolderId}`);
  } catch (e) {
    // ignore
  }
}

/**
 * Tải danh sách ảnh qua Google Apps Script Web App (HOÀN TOÀN KHÔNG CẦN GOOGLE DRIVE API KEY).
 */
async function loadFromAppsScript(rootFolderId, appsScriptUrl, onProgress, forceRefresh = false) {
  const safeProgress = typeof onProgress === 'function' ? onProgress : null;
  if (!forceRefresh) {
    const cached = getCachedAlbum(rootFolderId);
    if (cached) {
      safeProgress?.('Đang tải tức thì từ bộ nhớ đệm (Cache)...');
      return cached;
    }
  }

  safeProgress?.('Đang kết nối Google Drive qua Apps Script (không cần API Key)...');
  const sep = appsScriptUrl.includes('?') ? '&' : '?';
  const refreshParam = forceRefresh ? '&refresh=1' : '';
  const url = `${appsScriptUrl}${sep}folderId=${encodeURIComponent(rootFolderId)}${refreshParam}`;
  
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Không thể kết nối Google Apps Script (HTTP ${res.status}).`);
  }
  const data = await res.json();
  if (data.status === 'error') {
    throw new Error(data.message || 'Lỗi khi đọc thư mục Google Drive qua Apps Script.');
  }

  const photos = (data.photos || []).map((file) => {
    const urls = buildDriveUrls(file);
    return {
      id: file.id,
      name: file.name,
      baseName: stripExtension(file.name),
      mimeType: file.mimeType,
      size: file.size || 0,
      folderId: file.folderId || rootFolderId,
      folderName: file.folderName || 'Ảnh chung',
      width: 1200,
      height: 800,
      aspectRatio: 1.5,
      hasExactSize: false,
      thumbnailLink: file.thumbnailLink || '',
      ...urls,
    };
  });

  const result = {
    folders: data.folders || [],
    photos,
    isFromCache: false,
  };

  setCachedAlbum(rootFolderId, result);
  return result;
}

/**
 * Tải toàn bộ ảnh từ thư mục Google Drive gốc và các thư mục phân cảnh con.
 * Hỗ trợ 2 phương thức:
 * 1. Google Drive API Key (REST API v3)
 * 2. Google Apps Script Web App (Không cần bất kỳ API Key nào)
 * @returns {Promise<{ folders: Array<{id, name, count}>, photos: Array, isFromCache?: boolean }>}
 */
export async function loadDriveAlbum(rootFolderId, apiKey, onProgress, forceRefresh = false) {
  const safeProgress = typeof onProgress === 'function' ? onProgress : null;
  const activeKey = apiKey || localStorage.getItem('studio_drive_api_key') || '';
  const appsScriptUrl =
    STUDIO_CONFIG.googleSheetsWebhookUrl ||
    localStorage.getItem('studio_apps_script_url') ||
    '';

  // Nếu không có API Key nhưng có Web App Apps Script -> tải không cần Key
  if (!activeKey && appsScriptUrl) {
    return await loadFromAppsScript(rootFolderId, appsScriptUrl, safeProgress, forceRefresh);
  }

  if (!activeKey) {
    const err = new Error(
      'Chưa cấu hình Google Drive API Key. Bạn có thể:\n' +
      '• Cách 1: Dán Google Drive API Key trong file config.js hoặc mục #admin.\n' +
      '• Cách 2: Dùng Google Apps Script (Miễn phí 100%, KHÔNG CẦN API KEY, xem file apps-script/Code.gs).'
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }

  if (!forceRefresh) {
    const cached = getCachedAlbum(rootFolderId);
    if (cached) {
      onProgress?.('Đang tải tức thì từ bộ nhớ đệm (Cache)...');
      return cached;
    }
  }

  onProgress?.('Đang kết nối Google Drive API v3...');
  const rootChildren = await listFolderChildren(rootFolderId, activeKey);

  const subFolders = rootChildren
    .filter((item) => item.mimeType === FOLDER_MIME)
    .sort((a, b) => naturalCollator.compare(a.name, b.name));

  const rootImages = rootChildren
    .filter((item) => SUPPORTED_IMAGE_MIMES.has(item.mimeType))
    .sort((a, b) => naturalCollator.compare(a.name, b.name));

  const photos = [];
  const folders = [];

  if (rootImages.length > 0) {
    const rootLabel = subFolders.length > 0 ? 'Ảnh chung' : 'Album chính';
    folders.push({
      id: rootFolderId,
      name: rootLabel,
      count: rootImages.length,
    });
    for (const file of rootImages) {
      photos.push(normalizeDrivePhoto(file, rootFolderId, rootLabel));
    }
  }

  // Tải song song có kiểm soát (tối đa 4 thư mục con cùng lúc)
  if (subFolders.length > 0) {
    onProgress?.(`Đang tải ${subFolders.length} thư mục phân cảnh...`);
    const concurrency = 4;
    let index = 0;

    async function worker() {
      while (index < subFolders.length) {
        const current = subFolders[index++];
        try {
          const children = await listFolderChildren(current.id, activeKey);
          const imgs = children
            .filter((item) => SUPPORTED_IMAGE_MIMES.has(item.mimeType))
            .sort((a, b) => naturalCollator.compare(a.name, b.name));

          if (imgs.length > 0) {
            folders.push({
              id: current.id,
              name: current.name,
              count: imgs.length,
            });
            for (const file of imgs) {
              photos.push(normalizeDrivePhoto(file, current.id, current.name));
            }
          }
        } catch (subErr) {
          console.warn(`Không thể đọc thư mục con "${current.name}":`, subErr);
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, subFolders.length) }, worker)
    );

    // Sắp xếp lại danh sách thư mục theo thứ tự tên (giữ "Ảnh chung" đầu tiên nếu có)
    folders.sort((a, b) => {
      if (a.id === rootFolderId) return -1;
      if (b.id === rootFolderId) return 1;
      return naturalCollator.compare(a.name, b.name);
    });
  }

  const result = { folders, photos, isFromCache: false };
  setCachedAlbum(rootFolderId, result);
  return result;
}

/**
 * Bộ dữ liệu Demo tích hợp sẵn (ảnh mẫu cục bộ với các khuôn mặt nhất quán để thử mọi tính năng kể cả AI lọc khuôn mặt).
 */
export async function loadDemoAlbum() {
  const demoCatalog = [
    {
      id: 'demo_0012',
      name: 'DSC_0012.JPG',
      folderId: 'scene_giatien',
      folderName: 'Lễ gia tiên',
      file: 'assets/demo/DSC_0012.jpg',
      width: 800,
      height: 1200,
    },
    {
      id: 'demo_0024',
      name: 'DSC_0024.JPG',
      folderId: 'scene_giatien',
      folderName: 'Lễ gia tiên',
      file: 'assets/demo/DSC_0024.jpg',
      width: 800,
      height: 1200,
    },
    {
      id: 'demo_0031',
      name: 'DSC_0031.JPG',
      folderId: 'scene_giatien',
      folderName: 'Lễ gia tiên',
      file: 'assets/demo/DSC_0031.jpg',
      width: 1200,
      height: 800,
    },
    {
      id: 'demo_0045',
      name: 'DSC_0045.JPG',
      folderId: 'scene_ngoaicanh',
      folderName: 'Ngoại cảnh',
      file: 'assets/demo/DSC_0045.jpg',
      width: 1200,
      height: 800,
    },
    {
      id: 'demo_0068',
      name: 'DSC_0068.JPG',
      folderId: 'scene_ngoaicanh',
      folderName: 'Ngoại cảnh',
      file: 'assets/demo/DSC_0068.jpg',
      width: 800,
      height: 1200,
    },
    {
      id: 'demo_0089',
      name: 'DSC_0089.JPG',
      folderId: 'scene_ngoaicanh',
      folderName: 'Ngoại cảnh',
      file: 'assets/demo/DSC_0089.jpg',
      width: 800,
      height: 1000,
    },
    {
      id: 'demo_0108',
      name: 'DSC_0108.JPG',
      folderId: 'scene_tieccuoi',
      folderName: 'Tiệc cưới',
      file: 'assets/demo/DSC_0108.jpg',
      width: 1200,
      height: 800,
    },
    {
      id: 'demo_0134',
      name: 'DSC_0134.JPG',
      folderId: 'scene_tieccuoi',
      folderName: 'Tiệc cưới',
      file: 'assets/demo/DSC_0134.jpg',
      width: 800,
      height: 1000,
    },
    {
      id: 'demo_0152',
      name: 'DSC_0152.JPG',
      folderId: 'scene_tieccuoi',
      folderName: 'Tiệc cưới',
      file: 'assets/demo/DSC_0152.jpg',
      width: 1200,
      height: 800,
    },
  ];

  const folderMap = new Map();
  const photos = demoCatalog.map((item) => {
    const existing = folderMap.get(item.folderId) || {
      id: item.folderId,
      name: item.folderName,
      count: 0,
    };
    existing.count += 1;
    folderMap.set(item.folderId, existing);

    return {
      id: item.id,
      name: item.name,
      baseName: stripExtension(item.name),
      mimeType: 'image/jpeg',
      size: 0,
      folderId: item.folderId,
      folderName: item.folderName,
      width: item.width,
      height: item.height,
      aspectRatio: item.width / item.height,
      hasExactSize: true,
      aiUrl: item.file,
      aiFallbacks: [],
      gridUrl: item.file,
      gridFallbacks: [],
      lightboxUrl: item.file,
      lightboxFallbacks: [],
      downloadUrl: item.file,
      isDemo: true,
    };
  });

  return {
    folders: Array.from(folderMap.values()),
    photos,
  };
}

/**
 * Helper gắn nguồn ảnh với chuỗi fallback tự động khi 1 endpoint Drive lỗi hoặc chậm.
 */
export function attachImageWithFallback(imgEl, primaryUrl, fallbacks = [], onLoaded) {
  const candidates = [primaryUrl, ...fallbacks].filter(Boolean);
  let idx = 0;

  const tryNext = () => {
    if (idx >= candidates.length) {
      imgEl.classList.add('img-error');
      return;
    }
    imgEl.src = candidates[idx++];
  };

  imgEl.onerror = () => {
    tryNext();
  };
  imgEl.onload = () => {
    imgEl.classList.add('is-loaded');
    onLoaded?.(imgEl);
  };

  tryNext();
}

/**
 * Bóc tách Google Drive Folder ID từ mọi định dạng đường dẫn hoặc ID thô.
 */
export function extractDriveFolderId(input) {
  if (!input) return '';
  const trimmed = input.trim();

  // Định dạng /folders/<ID> (bao gồm /drive/folders/..., /drive/u/0/folders/...)
  const folderPathMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderPathMatch) return folderPathMatch[1];

  // Định dạng ?id=<ID> hoặc &id=<ID>
  const queryIdMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (queryIdMatch) return queryIdMatch[1];

  // Định dạng dán trực tiếp Folder ID
  if (/^[a-zA-Z0-9_-]{10,120}$/.test(trimmed)) {
    return trimmed;
  }

  return '';
}
