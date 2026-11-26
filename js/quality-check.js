/**
 * AI Kiểm tra chất lượng ảnh (chạy 100% trên trình duyệt, không gửi ảnh đi đâu):
 *  1. Ảnh mờ / rung: đo độ nét bằng phương sai Laplacian trên vùng khuôn mặt
 *     (hoặc ô nét nhất của ảnh nếu không có mặt) -> so với trung vị cả album.
 *  2. Nhắm mắt: tỉ lệ mở mắt (Eye Aspect Ratio) từ 468 điểm Face Mesh (@vladmandic/human).
 *  3. Ảnh chụp liên tiếp gần giống nhau: dấu vân tay ảnh (dHash 64-bit) + thứ tự tên file,
 *     gom thành nhóm và gợi ý tấm đẹp nhất mỗi nhóm.
 * Kết quả được lưu localStorage theo từng album để lần sau mở ra là có ngay.
 */
import { STUDIO_CONFIG } from '../config.js?v=10.42';
import { StorageManager } from './storage.js?v=10.42';

const CACHE_PREFIX = 'dip_quality_v1_';

const DEFAULTS = {
  blurRatio: 0.38, // Ảnh có độ nét < 38% trung vị album -> nghi mờ
  blinkEar: 0.18, // Tỉ lệ mở mắt trung bình < 0.18 -> nghi nhắm mắt
  minEyeFacePx: 34, // Mặt nhỏ hơn (px trên ảnh w400) thì không đánh giá mắt (không đủ chi tiết)
  dupHamming: 10, // Khác biệt dHash <= 10/64 bit -> ảnh gần giống nhau
};

function cfg() {
  return { ...DEFAULTS, ...(STUDIO_CONFIG.qualityAI || {}) };
}

function popcount32(n) {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i += 8) {
    d += popcount32((parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0);
  }
  return d;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class PhotoQualityAnalyzer {
  constructor(faceEngine) {
    this.faceEngine = faceEngine;
    this.isScanning = false;
    this.isCancelled = false;
  }

  stop() {
    this.isCancelled = true;
  }

  // ---------------- Cache ----------------
  loadCache(albumKey) {
    try {
      return JSON.parse(localStorage.getItem(CACHE_PREFIX + albumKey)) || {};
    } catch (e) {
      return {};
    }
  }

  saveCache(albumKey, data) {
    try {
      localStorage.setItem(CACHE_PREFIX + albumKey, JSON.stringify(data));
    } catch (e) {
      console.warn('Không lưu được cache chất lượng ảnh:', e);
    }
  }

  clearCache(albumKey) {
    try { localStorage.removeItem(CACHE_PREFIX + albumKey); } catch (e) {}
  }

  // ---------------- Phân tích điểm ảnh ----------------
  /**
   * Phương sai Laplacian trong 1 vùng chữ nhật của ảnh xám
   */
  laplacianVariance(gray, W, x0, y0, x1, y1) {
    x0 = Math.max(1, Math.floor(x0));
    y0 = Math.max(1, Math.floor(y0));
    x1 = Math.min(W - 1, Math.floor(x1));
    const H = gray.length / W;
    y1 = Math.min(H - 1, Math.floor(y1));
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      const row = y * W;
      for (let x = x0; x < x1; x++) {
        const i = row + x;
        const v = gray[i - 1] + gray[i + 1] + gray[i - W] + gray[i + W] - 4 * gray[i];
        sum += v;
        sumSq += v * v;
        n++;
      }
    }
    if (n < 64) return null;
    const mean = sum / n;
    return sumSq / n - mean * mean;
  }

  /**
   * Tính độ nét + dấu vân tay dHash của 1 ảnh
   * @param {HTMLImageElement} img
   * @param {Array} faces - [{ box:[x,y,w,h] }] theo toạ độ ảnh gốc của img
   */
  analyzePixels(img, faces) {
    const nw = img.naturalWidth || img.width;
    const nh = img.naturalHeight || img.height;
    const W = Math.min(400, nw);
    const scale = W / nw;
    const H = Math.max(8, Math.round(nh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    const gray = new Float32Array(W * H);
    for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
      gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }

    // 1. Độ nét vùng khuôn mặt (mặt đủ lớn)
    let faceSharp = null;
    for (const f of faces || []) {
      const b = f.box;
      if (!b) continue;
      const [x, y, w, h] = b.map((v) => v * scale);
      if (w < 40) continue;
      const v = this.laplacianVariance(gray, W, x + w * 0.12, y + h * 0.12, x + w * 0.88, y + h * 0.88);
      if (v != null && (faceSharp == null || v > faceSharp)) faceSharp = v;
    }

    // 2. Độ nét ô nét nhất (lưới 4x4) - hợp với ảnh xoá phông
    let tileSharp = 0;
    const tw = W / 4;
    const th = H / 4;
    for (let ty = 0; ty < 4; ty++) {
      for (let tx = 0; tx < 4; tx++) {
        const v = this.laplacianVariance(gray, W, tx * tw, ty * th, (tx + 1) * tw, (ty + 1) * th);
        if (v != null && v > tileSharp) tileSharp = v;
      }
    }

    // 3. dHash 64-bit
    const hc = document.createElement('canvas');
    hc.width = 9;
    hc.height = 8;
    const hctx = hc.getContext('2d', { willReadFrequently: true });
    hctx.imageSmoothingEnabled = true;
    hctx.imageSmoothingQuality = 'high';
    hctx.drawImage(canvas, 0, 0, 9, 8);
    const hd = hctx.getImageData(0, 0, 9, 8).data;
    const g = [];
    for (let i = 0; i < hd.length; i += 4) g.push(0.299 * hd[i] + 0.587 * hd[i + 1] + 0.114 * hd[i + 2]);
    let hex = '';
    for (let row = 0; row < 8; row++) {
      let nibbleBits = 0;
      let bitsInNibble = 0;
      for (let col = 0; col < 8; col++) {
        const bit = g[row * 9 + col] > g[row * 9 + col + 1] ? 1 : 0;
        nibbleBits = (nibbleBits << 1) | bit;
        bitsInNibble++;
        if (bitsInNibble === 4) {
          hex += nibbleBits.toString(16);
          nibbleBits = 0;
          bitsInNibble = 0;
        }
      }
    }

    return {
      s: Math.round((faceSharp != null ? faceSharp : tileSharp) * 10) / 10,
      t: faceSharp != null ? 'f' : 't',
      h: hex,
    };
  }

  /**
   * Lấy dữ liệu mắt của từng khuôn mặt từ cache IndexedDB (nếu đã quét có mắt) hoặc chạy AI
   */
  async getFaces(photo, img, cachedFaces, human) {
    if (Array.isArray(cachedFaces) && cachedFaces.every((f) => 'eyes' in f)) {
      return cachedFaces;
    }
    if (!human) return Array.isArray(cachedFaces) ? cachedFaces : [];
    const res = await human.detect(img);
    const faces = this.faceEngine.facesFromResult(res);
    await StorageManager.setCachedVector(photo.id, faces);
    return faces;
  }

  /**
   * Quét chất lượng toàn album (chỉ quét ảnh chưa có trong cache)
   * @returns {Promise<Object>} raw map photoId -> { s, t, h, e:[[earL, earR, faceWidth]] }
   */
  async analyzeAlbum(photos, albumKey, onProgress) {
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    this.isScanning = true;
    this.isCancelled = false;
    const cache = this.loadCache(albumKey);

    try {
      const pending = photos.filter((p) => !cache[p.id]);
      let done = photos.length - pending.length;
      progress({ current: done, total: photos.length, msg: pending.length ? 'Đang khởi động AI...' : 'Đã có kết quả từ lần quét trước' });
      if (!pending.length) return cache;

      let human = null;
      try {
        human = await this.faceEngine.initHuman();
      } catch (e) {
        console.warn('Không tải được AI khuôn mặt, chỉ kiểm tra độ nét & ảnh trùng:', e);
      }

      const photoIds = pending.map((p) => p.id);
      const cachedVectors = await StorageManager.getBatchCachedVectors(photoIds);
      const batchSize = Math.max(2, Math.min(6, STUDIO_CONFIG.faceAI?.batchSize || 4));
      let lastSave = Date.now();

      for (let i = 0; i < pending.length; i += batchSize) {
        if (this.isCancelled) break;
        const batch = pending.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (photo) => {
            try {
              const img = await this.faceEngine.loadImageElement(photo.aiUrl);
              const faces = await this.getFaces(photo, img, cachedVectors.get(photo.id), human);
              const px = this.analyzePixels(img, faces);
              const e = faces
                .filter((f) => Array.isArray(f.eyes) && f.box)
                .map((f) => [f.eyes[0], f.eyes[1], Math.round(f.box[2])]);
              cache[photo.id] = { ...px, e };
            } catch (err) {
              console.warn(`Không kiểm tra được ảnh ${photo.name}:`, err);
            }
          })
        );
        done += batch.length;
        progress({ current: Math.min(done, photos.length), total: photos.length, msg: `Đang kiểm tra ${Math.min(done, photos.length)}/${photos.length} ảnh...` });
        if (Date.now() - lastSave > 4000) {
          this.saveCache(albumKey, cache);
          lastSave = Date.now();
        }
        await new Promise((r) => setTimeout(r, 16));
      }
      this.saveCache(albumKey, cache);
      return cache;
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Từ dữ liệu thô -> đánh giá từng ảnh + gom nhóm ảnh giống nhau
   * @returns {{ info: Map<string, object>, counts: object }}
   */
  summarize(photos, raw) {
    const c = cfg();
    const info = new Map();

    // Trung vị độ nét theo từng loại đo (mặt / ô nét nhất)
    const faceVals = [];
    const tileVals = [];
    for (const p of photos) {
      const r = raw[p.id];
      if (!r) continue;
      (r.t === 'f' ? faceVals : tileVals).push(r.s);
    }
    const allMed = median([...faceVals, ...tileVals]);
    const medFace = faceVals.length >= 5 ? median(faceVals) : allMed;
    const medTile = tileVals.length >= 5 ? median(tileVals) : allMed;

    for (const p of photos) {
      const r = raw[p.id];
      if (!r) continue;
      const med = r.t === 'f' ? medFace : medTile;
      const sharpRel = med > 0 ? r.s / med : 1;
      const blurry = sharpRel < c.blurRatio;

      // Nhắm mắt: chỉ xét các khuôn mặt chính (đủ lớn so với mặt lớn nhất)
      let blink = false;
      const eyes = (r.e || []).filter((e) => e[0] != null && e[1] != null);
      if (eyes.length) {
        const maxW = Math.max(...eyes.map((e) => e[2] || 0));
        const mains = eyes.filter((e) => e[2] >= Math.max(c.minEyeFacePx, maxW * 0.55));
        blink = mains.some((e) => (e[0] + e[1]) / 2 < c.blinkEar);
      }

      info.set(p.id, {
        sharpRel,
        blurry,
        blink,
        faces: eyes.length,
        groupId: null,
        groupSize: 1,
        groupIndex: 0,
        isBest: false,
      });
    }

    // Gom nhóm ảnh liên tiếp gần giống nhau (theo thứ tự tên file trong từng thư mục)
    const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
    const sorted = photos.filter((p) => raw[p.id]?.h).sort((a, b) => {
      if ((a.folderId || '') !== (b.folderId || '')) return (a.folderId || '').localeCompare(b.folderId || '');
      return collator.compare(a.name, b.name);
    });

    const groups = [];
    let cur = [];
    for (const p of sorted) {
      if (!cur.length) {
        cur = [p];
        continue;
      }
      const last = cur[cur.length - 1];
      const sameFolder = (last.folderId || '') === (p.folderId || '');
      const dLast = hammingHex(raw[last.id].h, raw[p.id].h);
      const dFirst = hammingHex(raw[cur[0].id].h, raw[p.id].h);
      if (sameFolder && dLast <= c.dupHamming && dFirst <= c.dupHamming + 6) {
        cur.push(p);
      } else {
        if (cur.length > 1) groups.push(cur);
        cur = [p];
      }
    }
    if (cur.length > 1) groups.push(cur);

    let dupPhotos = 0;
    groups.forEach((g, gi) => {
      // Điểm chọn tấm đẹp nhất: nét nhất, không nhắm mắt, không mờ
      let best = g[0];
      let bestScore = -Infinity;
      for (const p of g) {
        const q = info.get(p.id);
        const score = Math.min(q.sharpRel, 3) - (q.blink ? 2 : 0) - (q.blurry ? 1 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
      g.forEach((p, idx) => {
        const q = info.get(p.id);
        q.groupId = `g${gi + 1}`;
        q.groupSize = g.length;
        q.groupIndex = idx + 1;
        q.isBest = p.id === best.id;
      });
      dupPhotos += g.length;
    });

    let blurry = 0;
    let blink = 0;
    let clean = 0;
    for (const q of info.values()) {
      if (q.blurry) blurry++;
      if (q.blink) blink++;
      if (!q.blurry && !q.blink && (!q.groupId || q.isBest)) clean++;
    }

    return {
      info,
      counts: {
        analyzed: info.size,
        total: photos.length,
        blurry,
        blink,
        groups: groups.length,
        dupPhotos,
        clean,
      },
    };
  }
}
