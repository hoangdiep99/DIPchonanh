#!/usr/bin/env python3
"""
scripts/scan_faces.py
---------------------
Chạy mô hình AI InsightFace (ArcFace ResNet-100 / buffalo_l) chuẩn xác 99.8%
để phát hiện và gom nhóm khuôn mặt (Cô dâu, Chú rể, Người thân...) trong album ảnh.

Được thiết kế để chạy tự động qua GitHub Actions hoặc chạy trực tiếp trên máy tính.
Kết quả được xuất ra file data/faces_<slug>.json và ảnh avatar data/avatars/<slug>_person_X.jpg.
"""

import os
import sys
import json
import argparse
import time
from datetime import datetime
import urllib.request
import urllib.parse

try:
    import numpy as np
    import cv2
    import requests
    from sklearn.cluster import AgglomerativeClustering
    import insightface
    from insightface.app import FaceAnalysis
except ImportError:
    print("Vui lòng cài đặt các thư viện cần thiết:")
    print("pip install insightface onnxruntime opencv-python-headless numpy scikit-learn requests")
    sys.exit(1)

WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbwhM56WIhLELKURPR4q48gbjN0_S__6pXu0XP369sJeFKE3L3ffByWEJaQZ566IOZ4A/exec"

def resolve_target(target_arg):
    """
    Xác định folderId và slug từ tham số nhập vào.
    Hỗ trợ cả slug (vd: viet-phuc) hoặc ID Google Drive trực tiếp.
    """
    target = target_arg.strip()
    slug = target
    folder_id = target

    # Kiểm tra xem có khớp album mặc định trong config.js không
    config_path = os.path.join(os.path.dirname(__file__), "..", "config.js")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                content = f.read()
                # Tìm kiếm đơn giản trong defaultAlbums
                if f"slug: '{target}'" in content or f'slug: "{target}"' in content:
                    lines = content.splitlines()
                    for i, line in enumerate(lines):
                        if f"slug: '{target}'" in line or f'slug: "{target}"' in line:
                            # Quét ngược lại để tìm folderId
                            for j in range(max(0, i - 10), i):
                                if "folderId:" in lines[j]:
                                    parts = lines[j].split("folderId:")[1].strip().strip("',\"")
                                    folder_id = parts
                                    break
        except Exception as e:
            print(f"Lỗi đọc config.js: {e}")

    # Nếu target là slug và chưa tìm thấy folder_id hợp lệ, hỏi Webhook Google Apps Script
    if len(folder_id) < 15 and not folder_id.startswith("1"):
        try:
            res = requests.get(f"{WEBHOOK_URL}?action=get_album&slug={urllib.parse.quote(target)}", timeout=10)
            if res.ok:
                data = res.json()
                if data.get("status") == "success" and data.get("album"):
                    folder_id = data["album"].get("folderId", folder_id)
                    slug = target
        except Exception as e:
            print(f"Không thể tra cứu slug qua Webhook: {e}")

    # Nếu target là folderId Google Drive (dài từ 20-40 ký tự)
    if len(target) >= 20 and folder_id == target:
        slug = f"album_{target[:8]}"

    return folder_id, slug

def fetch_photos_from_drive(folder_id):
    """Lấy danh sách ảnh từ Google Apps Script Webhook."""
    print(f"📡 Đang kết nối lấy danh sách ảnh của folder ID: {folder_id}...")
    url = f"{WEBHOOK_URL}?folderId={urllib.parse.quote(folder_id)}"
    res = requests.get(url, timeout=25)
    if not res.ok:
        raise RuntimeError(f"Webhook trả về lỗi HTTP {res.status_code}")
    data = res.json()
    if data.get("status") != "success":
        raise RuntimeError(f"Lỗi lấy dữ liệu từ Drive: {data.get('message', 'Không rõ')}")
    photos = data.get("photos", [])
    print(f"✅ Tìm thấy {len(photos)} ảnh trong album.")
    return photos

def download_image_as_cv2(photo_id):
    """
    Tải thumbnail chất lượng cao w1024 từ Google Drive và chuyển thành numpy/cv2 image.
    Dùng w1024 vừa cực nét cho AI nhận diện, vừa tải siêu nhanh (100-200ms/ảnh).
    """
    thumb_url = f"https://drive.google.com/thumbnail?id={photo_id}&sz=w1024"
    try:
        resp = requests.get(thumb_url, timeout=12)
        if resp.ok and len(resp.content) > 1000:
            arr = np.frombuffer(resp.content, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            return img
    except Exception as e:
        print(f"Lỗi tải ảnh {photo_id}: {e}")
    return None

def main():
    parser = argparse.ArgumentParser(description="Quét nhận diện khuôn mặt bằng InsightFace AI chuẩn xác 99.8%")
    parser.add_argument("--target", required=True, help="Folder ID Google Drive hoặc Slug album (vd: viet-phuc)")
    parser.add_argument("--threshold", type=float, default=0.50, help="Ngưỡng so khớp Cosine (0.45 - 0.55)")
    parser.add_argument("--min-photos", type=int, default=2, help="Số ảnh tối thiểu để tạo 1 nhóm gương mặt")
    args = parser.parse_args()

    folder_id, slug = resolve_target(args.target)
    print("=" * 60)
    print(f"🤖 INSIGHTFACE AI FACE SCANNER (ArcFace ResNet-100)")
    print(f"📁 Target Slug : {slug}")
    print(f"🆔 Folder ID   : {folder_id}")
    print(f"🎯 Threshold   : {args.threshold} (Cosine Distance: {1.0 - args.threshold:.2f})")
    print("=" * 60)

    # 1. Lấy danh sách ảnh
    photos = fetch_photos_from_drive(folder_id)
    if not photos:
        print("❌ Không có ảnh nào để quét.")
        sys.exit(0)

    # 2. Khởi tạo mô hình InsightFace (buffalo_l: RetinaFace + ArcFace)
    print("⏳ Đang nạp mô hình AI InsightFace (buffalo_l: RetinaFace + ArcFace)...")
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(640, 640))
    print("✅ Mô hình AI sẵn sàng!")

    # 3. Quét từng ảnh và trích xuất vector khuôn mặt
    all_detections = []
    print(f"🔍 Bắt đầu quét {len(photos)} ảnh...")

    start_time = time.time()
    for idx, photo in enumerate(photos):
        p_id = photo["id"]
        p_name = photo.get("name", p_id)
        img = download_image_as_cv2(p_id)
        if img is None:
            continue

        faces = app.get(img)
        print(f"[{idx+1}/{len(photos)}] {p_name}: Phát hiện {len(faces)} khuôn mặt.")

        for face in faces:
            # Lấy embedding đã chuẩn hóa
            emb = face.normed_embedding
            if emb is None or len(emb) == 0:
                continue

            bbox = [int(v) for v in face.bbox] # x1, y1, x2, y2
            all_detections.append({
                "photo_id": p_id,
                "photo_name": p_name,
                "embedding": emb,
                "bbox": bbox,
                "det_score": float(face.det_score) if hasattr(face, "det_score") else 0.9,
                "img_shape": img.shape[:2] # h, w
            })

    total_faces = len(all_detections)
    print(f"\n📊 Tổng cộng phát hiện {total_faces} khuôn mặt sau {time.time() - start_time:.1f}s.")
    if total_faces == 0:
        print("❌ Không phát hiện khuôn mặt nào trong album.")
        sys.exit(0)

    # 4. Gom nhóm bằng thuật toán Agglomerative Clustering (Khoảng cách Cosine)
    print(f"🧩 Đang gom nhóm các khuôn mặt của từng người (Threshold: {args.threshold})...")
    embeddings = np.array([d["embedding"] for d in all_detections])

    # Khoảng cách Cosine = 1.0 - Cosine Similarity
    dist_threshold = max(0.1, 1.0 - args.threshold)
    clustering = AgglomerativeClustering(
        n_clusters=None,
        distance_threshold=dist_threshold,
        metric="cosine",
        linkage="average"
    )
    labels = clustering.fit_predict(embeddings)

    # Gom các phát hiện theo từng nhãn cụ thể
    clusters_map = {}
    for idx, cluster_label in enumerate(labels):
        if cluster_label not in clusters_map:
            clusters_map[cluster_label] = []
        clusters_map[cluster_label].append(all_detections[idx])

    # 5. Lọc và định dạng danh sách người
    data_dir = os.path.join(os.path.dirname(__file__), "..", "data")
    avatars_dir = os.path.join(data_dir, "avatars")
    os.makedirs(avatars_dir, exist_ok=True)

    sorted_groups = sorted(clusters_map.values(), key=lambda g: len(set(d["photo_id"] for d in g)), reverse=True)

    final_clusters = []
    person_idx = 1

    for group in sorted_groups:
        photo_ids = list(dict.fromkeys(d["photo_id"] for d in group)) # Unique photo IDs
        if len(photo_ids) < args.min_photos and len(sorted_groups) > 2:
            continue

        # Chọn khuôn mặt đại diện đẹp nhất (det_score cao nhất và khung hình to rõ)
        best_det = max(group, key=lambda d: d["det_score"] * (d["bbox"][2] - d["bbox"][0]))
        rep_photo_id = best_det["photo_id"]
        bbox = best_det["bbox"]

        # Cắt avatar chân dung tròn đẹp mắt (crop face with 25% padding)
        avatar_rel_path = f"data/avatars/{slug}_person_{person_idx}.jpg"
        avatar_full_path = os.path.join(avatars_dir, f"{slug}_person_{person_idx}.jpg")

        rep_img = download_image_as_cv2(rep_photo_id)
        if rep_img is not None:
            ih, iw = rep_img.shape[:2]
            x1, y1, x2, y2 = bbox
            bw, bh = x2 - x1, y2 - y1
            pad = int(max(bw, bh) * 0.25)
            nx1 = max(0, x1 - pad)
            ny1 = max(0, y1 - pad)
            nx2 = min(iw, x2 + pad)
            ny2 = min(ih, y2 + pad)
            crop = rep_img[ny1:ny2, nx1:nx2]
            if crop.size > 0:
                crop_resized = cv2.resize(crop, (160, 160), interpolation=cv2.INTER_AREA)
                cv2.imwrite(avatar_full_path, crop_resized, [cv2.IMWRITE_JPEG_QUALITY, 92])

        label_name = f"Người {person_idx}"
        if person_idx == 1 and len(photo_ids) >= len(photos) * 0.3:
            label_name = "Nhân vật chính 1"
        elif person_idx == 2 and len(photo_ids) >= len(photos) * 0.3:
            label_name = "Nhân vật chính 2"

        final_clusters.append({
            "id": f"person_{person_idx}",
            "label": label_name,
            "avatarUrl": avatar_rel_path,
            "photoCount": len(photo_ids),
            "photoIds": photo_ids,
            "bestPhotoId": rep_photo_id
        })
        person_idx += 1

    print(f"✨ Đã phân loại thành công {len(final_clusters)} người trong album!")

    # 6. Ghi kết quả ra data/faces_<slug>.json và data/faces_<folderId>.json
    output_filename = f"faces_{slug}.json"
    output_path = os.path.join(data_dir, output_filename)

    result_json = {
        "slug": slug,
        "folderId": folder_id,
        "model": "InsightFace ArcFace ResNet-100 (buffalo_l)",
        "scannedAt": datetime.now().isoformat(),
        "totalPhotos": len(photos),
        "totalFacesDetected": total_faces,
        "clustersCount": len(final_clusters),
        "clusters": final_clusters
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result_json, f, ensure_ascii=False, indent=2)

    # Đồng thời ghi theo folderId để truy cập theo link folder=... vẫn nạp được ngay
    if folder_id and folder_id != slug:
        folder_output_path = os.path.join(data_dir, f"faces_{folder_id}.json")
        with open(folder_output_path, "w", encoding="utf-8") as f:
            json.dump(result_json, f, ensure_ascii=False, indent=2)

    print(f"💾 Đã lưu kết quả tại: {output_path}")
    print("=" * 60)
    print("🎉 HOÀN TẤT QUÉT AI KHUÔN MẶT!")

if __name__ == "__main__":
    main()
