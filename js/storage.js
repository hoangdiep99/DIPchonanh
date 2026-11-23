/**
 * IndexedDB storage dành cho:
 * 1. studio_select_<FOLDER_ID>: Lưu nháp trạng thái lựa chọn & ghi chú (offline-first).
 * 2. studio_face_cache: Lưu cache vector embedding khuôn mặt của từng FILE_ID (quét 1 lần, các lần lọc sau tức thì).
 */

const DB_NAME = 'StudioPhotoSelectorDB';
const DB_VERSION = 1;
const STORE_FACE_VECTORS = 'face_vectors';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_FACE_VECTORS)) {
        db.createObjectStore(STORE_FACE_VECTORS, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const StorageManager = {
  // --- LocalStorage lưu nháp theo FOLDER_ID (studio_select_<FOLDER_ID>) ---
  getDraftKey(folderId) {
    return `studio_select_${folderId || 'default'}`;
  },

  loadDraft(folderId) {
    try {
      const raw = localStorage.getItem(this.getDraftKey(folderId));
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch (e) {
      console.warn('Không thể đọc dữ liệu nháp từ localStorage:', e);
      return {};
    }
  },

  saveDraft(folderId, selectionsMap) {
    try {
      const key = this.getDraftKey(folderId);
      const data = {};
      for (const [id, item] of selectionsMap.entries()) {
        if (item.selected || item.priority || item.tags?.length || item.note) {
          data[id] = {
            selected: Boolean(item.selected),
            priority: Boolean(item.priority),
            tags: item.tags || [],
            note: item.note || '',
            updatedAt: Date.now(),
          };
        }
      }
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (e) {
      console.warn('Lỗi khi lưu nháp vào localStorage:', e);
      return false;
    }
  },

  clearDraft(folderId) {
    try {
      localStorage.removeItem(this.getDraftKey(folderId));
    } catch (e) {
      console.warn(e);
    }
  },

  // --- Phân hệ Đồng Bộ Đa Thiết Bị Đám Mây (Cloud Sync) ---
  getDeviceId() {
    let id = localStorage.getItem('studio_device_id');
    if (!id) {
      id = 'dev_' + Math.random().toString(36).substring(2, 9);
      localStorage.setItem('studio_device_id', id);
    }
    return id;
  },

  async fetchCloudDraft(appsScriptUrl, folderId) {
    if (!appsScriptUrl || !folderId) return null;
    try {
      const sep = appsScriptUrl.includes('?') ? '&' : '?';
      const url = `${appsScriptUrl}${sep}action=get_sync&folderId=${encodeURIComponent(folderId)}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      if (data.status === 'success' && data.draft) {
        return {
          draft: data.draft,
          updatedAt: data.updatedAt || 0,
        };
      }
      if (data.photos) {
        // Web App vẫn đang chạy Phiên bản 1 cũ chưa redeploy
        return { isOldVersion: true };
      }
      return null;
    } catch (e) {
      console.warn('Không thể kéo dữ liệu đồng bộ đám mây:', e);
      return null;
    }
  },

  async saveCloudDraft(appsScriptUrl, folderId, clientName, selectionsMap) {
    if (!appsScriptUrl || !folderId) return false;
    try {
      const draftObj = {};
      for (const [id, item] of selectionsMap.entries()) {
        if (item.selected || item.priority || item.tags?.length || item.note) {
          draftObj[id] = {
            selected: Boolean(item.selected),
            priority: Boolean(item.priority),
            tags: item.tags || [],
            note: item.note || '',
            updatedAt: item.updatedAt || Date.now(),
          };
        }
      }

      const payload = {
        action: 'save_sync',
        folderId,
        clientName: clientName || '',
        updatedAt: Date.now(),
        deviceName: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'Điện thoại' : 'Máy tính',
        draft: draftObj,
      };

      await fetch(appsScriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        mode: 'no-cors',
      });
      return true;
    } catch (e) {
      console.warn('Không thể gửi bản nháp lên đám mây:', e);
      return false;
    }
  },

  mergeDrafts(localDraft, cloudDraft) {
    // Hợp nhất dữ liệu giữa máy cục bộ và đám mây dựa trên thời gian cập nhật của từng ảnh
    const merged = { ...localDraft };
    for (const [id, cloudItem] of Object.entries(cloudDraft || {})) {
      if (!merged[id]) {
        merged[id] = cloudItem;
      } else {
        const localTime = merged[id].updatedAt || 0;
        const cloudTime = cloudItem.updatedAt || 0;
        if (cloudTime > localTime) {
          merged[id] = cloudItem;
        }
      }
    }
    return merged;
  },

  // --- IndexedDB Cache cho Vector Embedding khuôn mặt ---
  async getCachedVector(photoId) {
    try {
      const db = await openDatabase();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_FACE_VECTORS, 'readonly');
        const store = tx.objectStore(STORE_FACE_VECTORS);
        const req = store.get(photoId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  },

  async setCachedVector(photoId, facesData) {
    try {
      const db = await openDatabase();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_FACE_VECTORS, 'readwrite');
        const store = tx.objectStore(STORE_FACE_VECTORS);
        store.put({
          id: photoId,
          faces: facesData, // mảng { box, embedding }
          timestamp: Date.now(),
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  },

  async getBatchCachedVectors(photoIds) {
    const results = new Map();
    try {
      const db = await openDatabase();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_FACE_VECTORS, 'readonly');
        const store = tx.objectStore(STORE_FACE_VECTORS);
        let count = 0;
        if (photoIds.length === 0) return resolve(results);

        for (const id of photoIds) {
          const req = store.get(id);
          req.onsuccess = () => {
            if (req.result) results.set(id, req.result.faces);
            count++;
            if (count === photoIds.length) resolve(results);
          };
          req.onerror = () => {
            count++;
            if (count === photoIds.length) resolve(results);
          };
        }
      });
    } catch {
      return results;
    }
  },
};
