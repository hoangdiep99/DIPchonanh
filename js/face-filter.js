/**
 * Phân hệ 4.3: Nhận diện khuôn mặt nhẹ trên trình duyệt (@vladmandic/human)
 * - Tải trì hoãn (Lazy-load AI): Chỉ nạp khi khách bấm nút Lọc khuôn mặt (~5-6MB).
 * - Cấu hình tối giản: Chỉ bật face.detector và face.description, tắt body/hand/cảm xúc.
 * - Quy trình "Chạm 1 ảnh mẫu để tìm":
 *    1. Khách chọn 1 ảnh mẫu trong album.
 *    2. Hệ thống phát hiện các khuôn mặt trong ảnh mẫu, vẽ khung để khách chạm chọn đúng người.
 *    3. Quét tuần tự theo lô (batchSize=6 ảnh thumbnail w400) để chống lag UI.
 *    4. Tính Cosine Similarity / human.match.similarity, lọc ảnh khớp và lưu cache IndexedDB.
 */
import { STUDIO_CONFIG } from '../config.js?v=10.21';
import { StorageManager } from './storage.js?v=10.21';

const PhotoEyeMath = {
  // Eye Aspect Ratio: (|p2-p6| + |p3-p5|) / (2|p1-p4|) — mắt mở ~0.25-0.35, nhắm < 0.18
  ear(mesh, idx) {
    if (!mesh || mesh.length < 400) return null;
    const p = idx.map((i) => mesh[i]);
    if (p.some((pt) => !pt)) return null;
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const horiz = d(p[0], p[3]);
    if (!horiz) return null;
    return (d(p[1], p[5]) + d(p[2], p[4])) / (2 * horiz);
  },
};

export class FaceFilterEngine {
  constructor() {
    this.human = null;
    this.isLoaded = false;
    this.isLoading = false;
    this.loadPromise = null;
    this.isScanning = false;
    this.isPaused = false;
    this.isCancelled = false;
  }

  /**
   * Tạm dừng quét
   */
  pauseScan() {
    if (this.isScanning) {
      this.isPaused = true;
    }
  }

  /**
   * Tiếp tục quét khi đang tạm dừng
   */
  resumeScan() {
    if (this.isScanning) {
      this.isPaused = false;
    }
  }

  /**
   * Dừng quét ngay lập tức
   */
  stopScan() {
    this.isCancelled = true;
    this.isPaused = false;
  }

  /**
   * Tải động thư viện @vladmandic/human từ CDN khi người dùng mở tính năng lọc
   */
  async initHuman() {
    if (this.isLoaded && this.human) return this.human;
    if (this.isLoading) return this.loadPromise;

    this.isLoading = true;
    this.loadPromise = (async () => {
      try {
        const esmUrl = STUDIO_CONFIG.faceAI.esmUrl;
        const module = await import(/* webpackIgnore: true */ esmUrl);
        const Human = module.default || module.Human;

        const config = {
          modelBasePath: STUDIO_CONFIG.faceAI.modelBasePath,
          backend: 'webgl',
          debug: false,
          async: true,
          face: {
            enabled: true,
            detector: {
              rotation: true,
              maxDetected: 10,
              minConfidence: 0.35,
              return: true,
            },
            mesh: { enabled: true },
            description: { enabled: true },
            iris: { enabled: false },
            emotion: { enabled: false },
            gender: { enabled: false },
          },
          body: { enabled: false },
          hand: { enabled: false },
          object: { enabled: false },
          gesture: { enabled: false },
          segmentation: { enabled: false },
        };

        const human = new Human(config);
        await human.load();
        this.human = human;
        this.isLoaded = true;
        this.isLoading = false;
        return human;
      } catch (err) {
        this.isLoading = false;
        console.error('Không thể nạp AI Face Recognition model:', err);
        throw new Error('Lỗi tải mô hình nhận diện khuôn mặt. Vui lòng kiểm tra kết nối mạng.');
      }
    })();

    return this.loadPromise;
  }

  /**
   * Tải ảnh thành Image Element an toàn với CORS để đưa vào WebGL/Canvas
   */
  async loadImageElement(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        // Thử lại không có crossOrigin nếu server không hỗ trợ, hoặc dùng fetch blob
        fetch(url)
          .then((res) => {
            if (!res.ok) throw new Error('Fetch image failed');
            return res.blob();
          })
          .then((blob) => {
            const blobUrl = URL.createObjectURL(blob);
            const bImg = new Image();
            bImg.onload = () => resolve(bImg);
            bImg.onerror = reject;
            bImg.src = blobUrl;
          })
          .catch(reject);
      };
      img.src = url;
    });
  }

  /**
   * Cắt ảnh đại diện cận cảnh khuôn mặt (Face Crop) từ ảnh gốc theo bounding box
   */
  async cropFaceAvatar(photoUrl, box, size = 160) {
    if (!box || !photoUrl) return photoUrl;
    try {
      const img = await this.loadImageElement(photoUrl);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');

      const [x, y, w, h] = Array.isArray(box) ? box : [box.x, box.y, box.width, box.height];
      if (!w || !h) return photoUrl;

      // Thêm lề 30% xung quanh khuôn mặt để hiển thị tự nhiên (như Google/Apple Photos)
      const marginX = w * 0.3;
      const marginY = h * 0.35;

      const cropX = Math.max(0, x - marginX);
      const cropY = Math.max(0, y - marginY);
      const cropW = Math.min(img.naturalWidth - cropX, w + marginX * 2);
      const cropH = Math.min(img.naturalHeight - cropY, h + marginY * 2);

      ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, size, size);
      return canvas.toDataURL('image/jpeg', 0.88);
    } catch (e) {
      console.warn('Không thể crop avatar khuôn mặt:', e);
      return photoUrl;
    }
  }

  /**
   * Phát hiện các khuôn mặt trong 1 bức ảnh (kèm box và embedding)
   */
  async detectFacesInImage(imgSource) {
    const human = await this.initHuman();
    let imageEl = imgSource;
    if (typeof imgSource === 'string') {
      imageEl = await this.loadImageElement(imgSource);
    }

    const res = await human.detect(imageEl);
    if (!res.face || res.face.length === 0) return [];

    return res.face.map((f) => ({
      box: f.box, // [x, y, width, height]
      boxRaw: f.boxRaw, // normalized [0..1]
      confidence: f.confidence || f.score || 0.9,
      embedding: f.embedding || f.descriptor || null,
    })).filter((f) => f.embedding && f.embedding.length > 0);
  }

  /**
   * Chuẩn hoá kết quả human.detect -> mảng { box, embedding, eyes:[earTrái, earPhải] }
   * (lưu thêm tỉ lệ mở mắt để tính năng AI lọc ảnh nhắm mắt dùng lại, và giải phóng tensor GPU)
   */
  facesFromResult(res) {
    const out = [];
    for (const f of res?.face || []) {
      try {
        if (f.tensor && typeof f.tensor.dispose === 'function') f.tensor.dispose();
      } catch (e) {}
      if (!f.embedding || f.embedding.length === 0) continue;
      const earL = PhotoEyeMath.ear(f.mesh, [33, 160, 158, 133, 153, 144]);
      const earR = PhotoEyeMath.ear(f.mesh, [362, 385, 387, 263, 373, 380]);
      out.push({
        box: Array.isArray(f.box) ? Array.from(f.box) : f.box,
        embedding: Array.from(f.embedding),
        eyes: earL != null && earR != null ? [Math.round(earL * 1000) / 1000, Math.round(earR * 1000) / 1000] : null,
      });
    }
    return out;
  }

  /**
   * Tính Cosine Similarity giữa 2 vector embedding
   */
  cosineSimilarity(vecA, vecB) {
    if (this.human?.match?.similarity) {
      return this.human.match.similarity(vecA, vecB);
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Quét toàn bộ album theo lô (batch), đọc IndexedDB trước, chỉ suy luận AI ảnh chưa có vector.
   * @param {Array} photos - Danh sách toàn bộ ảnh trong album
   * @param {Array<number>} targetEmbedding - Vector khuôn mặt mục tiêu
   * @param {Function} onProgress - Callback báo cáo tiến độ (current, total, phase)
   * @returns {Promise<Map<string, number>>} - Map photoId -> điểm tương đồng cao nhất
   */
  async scanAlbumForFace(photos, targetEmbedding, onProgress) {
    const safeProgress = typeof onProgress === 'function' ? onProgress : () => {};
    this.isScanning = true;
    this.isPaused = false;
    this.isCancelled = false;

    safeProgress({
      phase: 'init_model',
      current: 0,
      total: photos.length,
      matchesCount: 0,
      msg: 'Đang khởi động AI so khớp...'
    });

    try {
      const human = await this.initHuman();
      const batchSize = STUDIO_CONFIG.faceAI.batchSize || 6;
      const matchScores = new Map();

      safeProgress({
        phase: 'cache_lookup',
        current: 0,
        total: photos.length,
        matchesCount: 0,
        msg: 'Đang kiểm tra bộ nhớ đệm (IndexedDB)...'
      });

      // 1. Kiểm tra cache IndexedDB
      const photoIds = photos.map((p) => p.id);
      const cachedMap = await StorageManager.getBatchCachedVectors(photoIds);

      const pendingPhotos = [];

      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        const cachedFaces = cachedMap.get(p.id);
        if (cachedFaces) {
          // Đã có trong cache, tính ngay similarity
          let maxSim = 0;
          for (const face of cachedFaces) {
            if (face.embedding) {
              const sim = this.cosineSimilarity(targetEmbedding, face.embedding);
              if (sim > maxSim) maxSim = sim;
            }
          }
          if (maxSim > 0) matchScores.set(p.id, maxSim);
        } else {
          pendingPhotos.push(p);
        }
      }

      let scanned = photos.length - pendingPhotos.length;
      safeProgress({
        phase: pendingPhotos.length === 0 ? 'done' : 'cache_loaded',
        current: scanned,
        total: photos.length,
        matchesCount: matchScores.size,
        msg: scanned > 0 ? `Đã tìm thấy ${matchScores.size} ảnh khớp từ cache (${scanned}/${photos.length} ảnh)...` : 'Bắt đầu quét ảnh...'
      });

      if (pendingPhotos.length === 0 || this.isCancelled) {
        safeProgress({
          phase: 'done',
          current: photos.length,
          total: photos.length,
          matchesCount: matchScores.size,
          msg: `Hoàn tất! Tìm thấy ${matchScores.size} ảnh có mặt người này.`
        });
        return matchScores;
      }

      // 2. Quét các ảnh chưa cache theo từng lô
      scanned = photos.length - pendingPhotos.length;
      for (let i = 0; i < pendingPhotos.length; i += batchSize) {
        if (this.isCancelled) break;

        while (this.isPaused && !this.isCancelled) {
          safeProgress({
            phase: 'paused',
            current: scanned,
            total: photos.length,
            matchesCount: matchScores.size,
            msg: `Đang tạm dừng quét (${scanned}/${photos.length} ảnh)...`
          });
          await new Promise((r) => setTimeout(r, 200));
        }

        if (this.isCancelled) break;

        const batch = pendingPhotos.slice(i, i + batchSize);
        safeProgress({
          phase: 'ai_scanning',
          current: scanned,
          total: photos.length,
          batchCount: batch.length,
          matchesCount: matchScores.size,
          msg: `Đang so khớp ảnh ${scanned + 1} - ${Math.min(scanned + batch.length, photos.length)} / ${photos.length}...`
        });

        await Promise.all(
          batch.map(async (photo) => {
            try {
              // Sử dụng ảnh w400 (Cấp 1) siêu nhẹ để nhận diện nhanh
              const img = await this.loadImageElement(photo.aiUrl);
              const res = await human.detect(img);

              const detectedFaces = this.facesFromResult(res);
              let maxSim = 0;
              for (const f of detectedFaces) {
                const sim = this.cosineSimilarity(targetEmbedding, f.embedding);
                if (sim > maxSim) maxSim = sim;
              }

              // Lưu vào IndexedDB cho các lần lọc sau
              await StorageManager.setCachedVector(photo.id, detectedFaces);

              if (maxSim > 0) {
                matchScores.set(photo.id, maxSim);
              }
            } catch (err) {
              console.warn(`Lỗi nhận diện khuôn mặt ảnh ${photo.name}:`, err);
              // Vẫn lưu rỗng để không bị quét lại ảnh hỏng
              await StorageManager.setCachedVector(photo.id, []);
            }
          })
        );

        scanned += batch.length;
        safeProgress({
          phase: 'ai_scanning',
          current: scanned,
          total: photos.length,
          batchCount: batch.length,
          matchesCount: matchScores.size,
          msg: `Đã xử lý ${scanned}/${photos.length} ảnh (khớp ${matchScores.size} ảnh)...`
        });
        // Nhường CPU cho UI phản hồi mượt mà
        await new Promise((r) => setTimeout(r, 16));
      }

      safeProgress({
        phase: 'done',
        current: scanned,
        total: photos.length,
        matchesCount: matchScores.size,
        msg: `Hoàn tất! Tìm thấy ${matchScores.size} ảnh có mặt người này.`
      });
      return matchScores;
    } finally {
      this.isScanning = false;
      this.isPaused = false;
      this.isCancelled = false;
    }
  }

  /**
   * Quét toàn bộ album và tự động gom cụm các khuôn mặt khác nhau thành từng người riêng biệt.
   * @param {Array} photos - Toàn bộ ảnh
   * @param {Function} onProgress - Báo tiến độ
   * @param {number} threshold - Ngưỡng tương đồng
   * @returns {Promise<Array<{id, label, avatarUrl, photoCount, photoIds: Set, representativeEmbedding}>>}
   */
  async scanAndClusterAlbum(photos, onProgress, threshold = 0.52) {
    const safeProgress = typeof onProgress === 'function' ? onProgress : () => {};
    this.isScanning = true;
    this.isPaused = false;
    this.isCancelled = false;

    safeProgress({
      phase: 'init_model',
      current: 0,
      total: photos.length,
      foundFaces: 0,
      clustersCount: 0,
      msg: 'Đang khởi động mạng nơ-ron AI (WebGL / GPU)...'
    });

    try {
      const human = await this.initHuman();
      const batchSize = STUDIO_CONFIG.faceAI.batchSize || 6;

      // 1. Đọc cache IndexedDB
      const photoIds = photos.map((p) => p.id);
      const cachedMap = await StorageManager.getBatchCachedVectors(photoIds);
      const pendingPhotos = [];
      const allDetected = []; // mảng { photoId, photo, box, embedding }

      for (const p of photos) {
        const cachedFaces = cachedMap.get(p.id);
        if (cachedFaces) {
          for (const f of cachedFaces) {
            if (f.embedding) {
              allDetected.push({
                photoId: p.id,
                photo: p,
                box: f.box,
                embedding: f.embedding,
              });
            }
          }
        } else {
          pendingPhotos.push(p);
        }
      }

      let scanned = photos.length - pendingPhotos.length;
      safeProgress({
        phase: scanned === photos.length ? 'clustering' : 'cache_loaded',
        current: scanned,
        total: photos.length,
        foundFaces: allDetected.length,
        clustersCount: 0,
        msg: scanned > 0 ? `Đã nạp ${scanned}/${photos.length} ảnh từ cache (${allDetected.length} khuôn mặt)` : 'Bắt đầu quét ảnh...'
      });

      // 2. Quét các ảnh chưa lưu cache
      if (pendingPhotos.length > 0 && !this.isCancelled) {
        for (let i = 0; i < pendingPhotos.length; i += batchSize) {
          if (this.isCancelled) break;

          while (this.isPaused && !this.isCancelled) {
            safeProgress({
              phase: 'paused',
              current: scanned,
              total: photos.length,
              foundFaces: allDetected.length,
              clustersCount: 0,
              msg: `Đang tạm dừng quét (${scanned}/${photos.length} ảnh)...`
            });
            await new Promise((r) => setTimeout(r, 200));
          }

          if (this.isCancelled) break;

          const batch = pendingPhotos.slice(i, i + batchSize);
          safeProgress({
            phase: 'ai_scanning',
            current: scanned,
            total: photos.length,
            batchCount: batch.length,
            foundFaces: allDetected.length,
            clustersCount: 0,
            msg: `Đang quét ảnh ${scanned + 1} - ${Math.min(scanned + batch.length, photos.length)} / ${photos.length}...`
          });

          await Promise.all(
            batch.map(async (photo) => {
              try {
                const img = await this.loadImageElement(photo.aiUrl);
                const res = await human.detect(img);
                const detectedFaces = this.facesFromResult(res);
                for (const f of detectedFaces) {
                  allDetected.push({
                    photoId: photo.id,
                    photo: photo,
                    box: f.box,
                    embedding: f.embedding,
                  });
                }

                await StorageManager.setCachedVector(photo.id, detectedFaces);
              } catch (err) {
                console.warn(`Lỗi nhận diện khuôn mặt ảnh ${photo.name}:`, err);
                await StorageManager.setCachedVector(photo.id, []);
              }
            })
          );

          scanned += batch.length;
          safeProgress({
            phase: 'ai_scanning',
            current: scanned,
            total: photos.length,
            batchCount: batch.length,
            foundFaces: allDetected.length,
            clustersCount: 0,
            msg: `Đã xử lý ${scanned}/${photos.length} ảnh (${allDetected.length} khuôn mặt)...`
          });

          await new Promise((r) => setTimeout(r, 16));
        }
      }

      if (allDetected.length === 0) {
        return [];
      }

      safeProgress({
        phase: 'clustering',
        current: scanned,
        total: photos.length,
        foundFaces: allDetected.length,
        clustersCount: 0,
        msg: 'Đang gom cụm và phân loại các khuôn mặt...'
      });

      // 3. Thuật toán gom cụm khuôn mặt (Agglomerative Face Clustering)
      const clusters = [];

      for (const item of allDetected) {
        let bestCluster = null;
        let maxSim = 0;

        for (const cluster of clusters) {
          const sim = this.cosineSimilarity(item.embedding, cluster.representativeEmbedding);
          if (sim >= threshold && sim > maxSim) {
            maxSim = sim;
            bestCluster = cluster;
          }
        }

        if (bestCluster) {
          bestCluster.photoIds.add(item.photoId);
          bestCluster.members.push(item);
        } else {
          // Tạo cụm người mới
          clusters.push({
            id: `person_${clusters.length + 1}`,
            label: `Người ${clusters.length + 1}`,
            avatarUrl: item.photo.aiUrl,
            representativeEmbedding: item.embedding,
            box: item.box,
            photoIds: new Set([item.photoId]),
            members: [item],
          });
        }
      }

      // Sắp xếp các cụm người theo số lượng ảnh xuất hiện nhiều nhất lên đầu
      clusters.sort((a, b) => b.photoIds.size - a.photoIds.size);

      // Cập nhật lại nhãn sau khi sắp xếp & Cắt cận cảnh khuôn mặt làm avatar đại diện
      for (let idx = 0; idx < clusters.length; idx++) {
        const c = clusters[idx];
        c.label = `Người ${idx + 1}`;
        c.photoCount = c.photoIds.size;

        if (c.members && c.members.length > 0) {
          let bestMember = c.members[0];
          let maxArea = 0;
          for (const m of c.members) {
            if (m.box) {
              const [w, h] = Array.isArray(m.box) ? [m.box[2], m.box[3]] : [m.box.width, m.box.height];
              const area = (w || 0) * (h || 0);
              if (area > maxArea) {
                maxArea = area;
                bestMember = m;
              }
            }
          }
          if (bestMember && bestMember.box && bestMember.photo && bestMember.photo.aiUrl) {
            try {
              c.avatarUrl = await this.cropFaceAvatar(bestMember.photo.aiUrl, bestMember.box, 160);
              c.box = bestMember.box;
            } catch (e) {}
          }
        }
      }

      safeProgress({
        phase: 'done',
        current: scanned,
        total: photos.length,
        foundFaces: allDetected.length,
        clustersCount: clusters.length,
        msg: `Hoàn tất! Đã gom thành ${clusters.length} nhóm người.`
      });
      return clusters;
    } finally {
      this.isScanning = false;
      this.isPaused = false;
      this.isCancelled = false;
    }
  }
}
