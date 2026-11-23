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
import { STUDIO_CONFIG } from '../config.js?v=9.6';
import { StorageManager } from './storage.js?v=9.6';

export class FaceFilterEngine {
  constructor() {
    this.human = null;
    this.isLoaded = false;
    this.isLoading = false;
    this.loadPromise = null;
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
    onProgress?.({
      phase: 'init_model',
      current: 0,
      total: photos.length,
      matchesCount: 0,
      msg: 'Đang khởi động AI so khớp...'
    });

    const human = await this.initHuman();
    const batchSize = STUDIO_CONFIG.faceAI.batchSize || 6;
    const matchScores = new Map();

    onProgress?.({
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
    onProgress?.({
      phase: pendingPhotos.length === 0 ? 'done' : 'cache_loaded',
      current: scanned,
      total: photos.length,
      matchesCount: matchScores.size,
      msg: scanned > 0 ? `Đã tìm thấy ${matchScores.size} ảnh khớp từ cache (${scanned}/${photos.length} ảnh)...` : 'Bắt đầu quét ảnh...'
    });

    if (pendingPhotos.length === 0) {
      onProgress?.({
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
      const batch = pendingPhotos.slice(i, i + batchSize);
      onProgress?.({
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

            const detectedFaces = [];
            let maxSim = 0;

            if (res.face && res.face.length > 0) {
              for (const f of res.face) {
                if (f.embedding && f.embedding.length > 0) {
                  detectedFaces.push({
                    box: f.box,
                    embedding: Array.from(f.embedding),
                  });
                  const sim = this.cosineSimilarity(targetEmbedding, f.embedding);
                  if (sim > maxSim) maxSim = sim;
                }
              }
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
      onProgress?.({
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

    onProgress?.({
      phase: 'done',
      current: photos.length,
      total: photos.length,
      matchesCount: matchScores.size,
      msg: `Hoàn tất! Tìm thấy ${matchScores.size} ảnh có mặt người này.`
    });
    return matchScores;
  }

  /**
   * Quét toàn bộ album và tự động gom cụm các khuôn mặt khác nhau thành từng người riêng biệt.
   * @param {Array} photos - Toàn bộ ảnh
   * @param {Function} onProgress - Báo tiến độ
   * @param {number} threshold - Ngưỡng tương đồng
   * @returns {Promise<Array<{id, label, avatarUrl, photoCount, photoIds: Set, representativeEmbedding}>>}
   */
  async scanAndClusterAlbum(photos, onProgress, threshold = 0.52) {
    onProgress?.({
      phase: 'init_model',
      current: 0,
      total: photos.length,
      foundFaces: 0,
      clustersCount: 0,
      msg: 'Đang khởi động mạng nơ-ron AI (WebGL / GPU)...'
    });

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
    onProgress?.({
      phase: scanned === photos.length ? 'clustering' : 'cache_loaded',
      current: scanned,
      total: photos.length,
      foundFaces: allDetected.length,
      clustersCount: 0,
      msg: scanned > 0 ? `Đã nạp ${scanned}/${photos.length} ảnh từ cache (${allDetected.length} khuôn mặt)` : 'Bắt đầu quét ảnh...'
    });

    // 2. Quét các ảnh chưa lưu cache
    if (pendingPhotos.length > 0) {
      for (let i = 0; i < pendingPhotos.length; i += batchSize) {
        const batch = pendingPhotos.slice(i, i + batchSize);
        onProgress?.({
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
              const detectedFaces = [];

              if (res.face && res.face.length > 0) {
                for (const f of res.face) {
                  if (f.embedding && f.embedding.length > 0) {
                    const emb = Array.from(f.embedding);
                    detectedFaces.push({ box: f.box, embedding: emb });
                    allDetected.push({
                      photoId: photo.id,
                      photo: photo,
                      box: f.box,
                      embedding: emb,
                    });
                  }
                }
              }

              await StorageManager.setCachedVector(photo.id, detectedFaces);
            } catch (err) {
              console.warn(`Lỗi nhận diện khuôn mặt ảnh ${photo.name}:`, err);
              await StorageManager.setCachedVector(photo.id, []);
            }
          })
        );

        scanned += batch.length;
        onProgress?.({
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

    onProgress?.({
      phase: 'clustering',
      current: photos.length,
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

    // Cập nhật lại nhãn sau khi sắp xếp
    clusters.forEach((c, idx) => {
      c.label = `Người ${idx + 1}`;
      c.photoCount = c.photoIds.size;
    });

    onProgress?.({
      phase: 'done',
      current: photos.length,
      total: photos.length,
      foundFaces: allDetected.length,
      clustersCount: clusters.length,
      msg: `Hoàn tất! Đã gom thành ${clusters.length} nhóm người.`
    });
    return clusters;
  }
}
