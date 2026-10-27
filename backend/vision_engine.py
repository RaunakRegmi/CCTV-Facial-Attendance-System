"""
CCTV face recognition engine.

Pipeline per frame:
  1. YOLOv8 face detector (PyTorch, Apple Silicon MPS) finds face boxes.
  2. Each face is aligned to 112x112 using 5-point landmarks.
  3. InsightFace ArcFace (ONNX Runtime, CoreML) produces a 512-d embedding.
  4. Cosine similarity against enrolled students; best match above threshold wins.

Usage:
  python vision_engine.py --source test_video.mp4 --face-model yolov8n-face.pt
"""

import argparse
import re
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
import torch
from insightface.app import FaceAnalysis
from insightface.utils.face_align import norm_crop
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent

MATCH_THRESHOLD = 0.60
PRINT_COOLDOWN_SECONDS = 5.0  # don't re-print the same student every frame
CROP_PADDING = 0.25  # extra context around YOLO box before landmark detection


# ---------------------------------------------------------------------------
# Hardware
# ---------------------------------------------------------------------------

def get_torch_device():
    if torch.backends.mps.is_available():
        return "mps"
    print("[WARN] MPS backend not available, YOLO will run on CPU")
    return "cpu"


def get_onnx_providers():
    # InsightFace runs on ONNX Runtime, not PyTorch, so it can't use MPS.
    # CoreML is the Apple Silicon GPU/Neural Engine path for ONNX models.
    available = ort.get_available_providers()
    providers = [p for p in ("CoreMLExecutionProvider", "CPUExecutionProvider") if p in available]
    if "CoreMLExecutionProvider" not in providers:
        print("[WARN] CoreMLExecutionProvider not available, InsightFace will run on CPU")
    return providers


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

def load_face_detector(weights_path, device):
    if not Path(weights_path).exists():
        raise FileNotFoundError(
            f"Face detector weights not found: {weights_path}\n"
            "Stock yolov8n.pt is trained on COCO and has no 'face' class. "
            "Download a YOLOv8 face checkpoint (e.g. yolov8n-face.pt) and pass it with --face-model."
        )
    model = YOLO(weights_path)
    model.to(device)
    # Warm-up so the first real frame isn't slowed by MPS kernel compilation
    model.predict(np.zeros((640, 640, 3), dtype=np.uint8), device=device, verbose=False)
    print(f"[INFO] YOLO face detector loaded on {device}: {weights_path}")
    return model


def load_insightface(providers):
    app = FaceAnalysis(
        name="buffalo_l",
        providers=providers,
        allowed_modules=["detection", "recognition"],
    )
    app.prepare(ctx_id=0, det_size=(640, 640))
    print(f"[INFO] InsightFace buffalo_l loaded with {providers}")
    return app


# ---------------------------------------------------------------------------
# Enrollment
# ---------------------------------------------------------------------------

def name_from_filename(path):
    # "Raunak_Regmi.jpg" / "Raunak_Regmi_2.jpg" -> "Raunak Regmi"
    stem = re.sub(r"[_\-\s]\d+$", "", path.stem)
    return re.sub(r"[_\-]+", " ", stem).strip()


def enroll_students(app, photos_dir):
    photos = sorted(Path(photos_dir).glob("*.jpg")) + sorted(Path(photos_dir).glob("*.jpeg"))
    if not photos:
        raise FileNotFoundError(f"No .jpg files found in {photos_dir}")

    per_student = {}
    for path in photos:
        img = cv2.imread(str(path))
        if img is None:
            print(f"[WARN] Could not read {path.name}, skipping")
            continue
        faces = app.get(img)
        if not faces:
            print(f"[WARN] No face found in {path.name}, skipping")
            continue
        if len(faces) > 1:
            print(f"[WARN] {len(faces)} faces in {path.name}, using the largest")
        face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        per_student.setdefault(name_from_filename(path), []).append(face.normed_embedding)

    if not per_student:
        raise RuntimeError("Enrollment failed: no usable faces in any photo")

    names = list(per_student)
    # Several photos of one student are averaged into a single template
    embeddings = np.stack([np.mean(per_student[n], axis=0) for n in names])
    embeddings /= np.linalg.norm(embeddings, axis=1, keepdims=True)

    for n in names:
        print(f"[ENROLL] {n} ({len(per_student[n])} photo(s))")
    print(f"[INFO] Enrolled {len(names)} students")
    return names, embeddings.astype(np.float32)


# ---------------------------------------------------------------------------
# Detection + recognition
# ---------------------------------------------------------------------------

def detect_faces(model, frame, device, conf):
    """Returns a list of (x1, y1, x2, y2, kps_or_None) in frame coordinates."""
    result = model.predict(frame, device=device, conf=conf, verbose=False)[0]
    boxes = result.boxes.xyxy.cpu().numpy().astype(int)
    # Some face checkpoints are pose models that also predict 5 landmarks
    kps_all = None
    if result.keypoints is not None and result.keypoints.xy.shape[1] == 5:
        kps_all = result.keypoints.xy.cpu().numpy()
    return [(*box, kps_all[i] if kps_all is not None else None) for i, box in enumerate(boxes)]


def landmarks_from_crop(app, frame, box):
    """Run InsightFace's detector on a padded YOLO crop to get 5 alignment landmarks."""
    x1, y1, x2, y2 = box
    h, w = frame.shape[:2]
    pad_x, pad_y = int((x2 - x1) * CROP_PADDING), int((y2 - y1) * CROP_PADDING)
    cx1, cy1 = max(0, x1 - pad_x), max(0, y1 - pad_y)
    cx2, cy2 = min(w, x2 + pad_x), min(h, y2 + pad_y)
    crop = frame[cy1:cy2, cx1:cx2]
    if crop.size == 0:
        return None

    _, kpss = app.det_model.detect(crop, input_size=(160, 160), max_num=1)
    if kpss is None or len(kpss) == 0:
        return None
    return kpss[0] + np.array([cx1, cy1], dtype=np.float32)


def embed_faces(app, frame, detections):
    """Align each detected face and embed them in one batch. Returns (kept_detections, embeddings)."""
    aligned, kept = [], []
    for x1, y1, x2, y2, kps in detections:
        if kps is None:
            kps = landmarks_from_crop(app, frame, (x1, y1, x2, y2))
        if kps is None:
            continue  # too blurry/occluded/profile to align reliably
        aligned.append(norm_crop(frame, kps, image_size=112))
        kept.append((x1, y1, x2, y2))

    if not aligned:
        return [], np.empty((0, 512), dtype=np.float32)

    feats = app.models["recognition"].get_feat(aligned)
    feats /= np.linalg.norm(feats, axis=1, keepdims=True)
    return kept, feats


def match(embeddings, enrolled, names, threshold):
    """Cosine similarity (dot product of unit vectors) -> list of (name_or_None, score)."""
    if len(embeddings) == 0:
        return []
    sims = embeddings @ enrolled.T
    best = sims.argmax(axis=1)
    scores = sims[np.arange(len(best)), best]
    return [(names[i] if s > threshold else None, float(s)) for i, s in zip(best, scores)]


# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------

def draw(frame, box, name, score):
    x1, y1, x2, y2 = box
    color = (0, 200, 0) if name else (0, 0, 220)
    label = f"{name or 'Unknown'} {score:.2f}"
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 1)
    cv2.rectangle(frame, (x1, y1 - th - 8), (x1 + tw + 6, y1), color, -1)
    cv2.putText(frame, label, (x1 + 3, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def run(args):
    device = get_torch_device()
    detector = load_face_detector(args.face_model, device)
    app = load_insightface(get_onnx_providers())
    names, enrolled = enroll_students(app, args.photos)

    source = int(args.source) if args.source.isdigit() else args.source
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video source: {args.source}")

    last_printed = {}
    frame_idx, fps, t_prev = 0, 0.0, time.perf_counter()

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                print("[INFO] End of stream")
                break
            frame_idx += 1

            detections = detect_faces(detector, frame, device, args.conf)
            boxes, embeddings = embed_faces(app, frame, detections)

            for box, (name, score) in zip(boxes, match(embeddings, enrolled, names, args.threshold)):
                draw(frame, box, name, score)
                if name:
                    now = time.monotonic()
                    if now - last_printed.get(name, -PRINT_COOLDOWN_SECONDS) >= PRINT_COOLDOWN_SECONDS:
                        print(f"Recognized: {name} (score {score:.2f}, frame {frame_idx})")
                        last_printed[name] = now

            t_now = time.perf_counter()
            fps = 0.9 * fps + 0.1 * (1.0 / max(t_now - t_prev, 1e-6))
            t_prev = t_now

            if not args.no_display:
                cv2.putText(frame, f"FPS {fps:.1f} | faces {len(detections)}", (10, 28),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 0), 2, cv2.LINE_AA)
                cv2.imshow("CCTV Attendance", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    finally:
        cap.release()
        cv2.destroyAllWindows()


def parse_args():
    p = argparse.ArgumentParser(description="CCTV face recognition engine")
    p.add_argument("--source", default=str(SCRIPT_DIR / "test_video.mp4"),
                   help="Video file path, RTSP URL, or webcam index (e.g. 0)")
    p.add_argument("--photos", default=str(SCRIPT_DIR / "student_photos"),
                   help="Directory of enrollment .jpg files named after students")
    p.add_argument("--face-model", default=str(SCRIPT_DIR / "yolov8n-face.pt"),
                   help="YOLOv8 face detection weights")
    p.add_argument("--threshold", type=float, default=MATCH_THRESHOLD,
                   help="Cosine similarity needed to accept a match")
    p.add_argument("--conf", type=float, default=0.5, help="YOLO detection confidence")
    p.add_argument("--no-display", action="store_true", help="Run headless (no OpenCV window)")
    return p.parse_args()


if __name__ == "__main__":
    run(parse_args())
