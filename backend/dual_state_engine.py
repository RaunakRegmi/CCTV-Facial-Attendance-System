"""
Dual-State Engine: CCTV face recognition + per-minute Firestore sync.

Pipeline per frame:
  1. YOLOv8 face detector (PyTorch, Apple Silicon MPS) finds face boxes.
  2. Each face is aligned to 112x112 using 5-point landmarks.
  3. InsightFace ArcFace (ONNX Runtime, CoreML) produces a 512-d embedding.
  4. Cosine similarity against enrolled students; best match above threshold wins.
  5. Each match appends an attention score to an in-memory buffer.

Every SYNC_INTERVAL_SECONDS of wall-clock time the buffer is averaged per student
and written to Firestore `attendance_logs` in one batch, on a background thread so
the video loop never stalls. Remaining data is flushed on exit (q, end of stream,
Ctrl+C, or an error).

Usage:
  python dual_state_engine.py --source test_video.mp4 --face-model yolov8n-face.pt
"""

import argparse
import math
import re
import shutil
import ssl
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import certifi
import cv2
import firebase_admin
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision as mp_vision
import onnxruntime as ort
import torch
from firebase_admin import credentials, firestore
from insightface.app import FaceAnalysis
from insightface.utils.face_align import norm_crop
from ultralytics import YOLO

SCRIPT_DIR = Path(__file__).resolve().parent

MATCH_THRESHOLD = 0.60
PRINT_COOLDOWN_SECONDS = 5.0  # don't re-print the same student every frame
CROP_PADDING = 0.25  # extra context around YOLO box before landmark detection
SYNC_INTERVAL_SECONDS = 60
FIRESTORE_BATCH_LIMIT = 500  # Firestore's max writes per batch

# Attention scoring: points deducted per degree away from facing the camera
YAW_PENALTY_PER_DEG = 100 / 60  # looking 60° sideways alone -> 0
PITCH_PENALTY_PER_DEG = 100 / 45  # looking 45° down/up alone -> 0
FALLBACK_ATTENTION = 50.0  # no mesh found (blurry, tiny, or occluded face)

# MediaPipe Face Landmarker (the Tasks API replacement for the removed
# mp.solutions.face_mesh.FaceMesh; same 468-point mesh topology).
FACE_LANDMARKER_PATH = SCRIPT_DIR / "face_landmarker.task"
FACE_LANDMARKER_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)


def load_face_landmarker():
    if not FACE_LANDMARKER_PATH.exists():
        print(f"[INFO] Downloading MediaPipe face landmarker model to {FACE_LANDMARKER_PATH}")
        # certifi bundle: python.org macOS builds ship without root certs for urllib
        ctx = ssl.create_default_context(cafile=certifi.where())
        tmp = FACE_LANDMARKER_PATH.with_suffix(".part")
        with urllib.request.urlopen(FACE_LANDMARKER_URL, context=ctx) as resp, open(tmp, "wb") as f:
            shutil.copyfileobj(resp, f)
        tmp.rename(FACE_LANDMARKER_PATH)
    options = mp_vision.FaceLandmarkerOptions(
        base_options=mp_tasks.BaseOptions(model_asset_path=str(FACE_LANDMARKER_PATH)),
        # IMAGE mode (= old static_image_mode=True): consecutive calls receive crops
        # of *different* students, so video tracking would carry one student's
        # landmarks over as the search region for the next student's crop.
        running_mode=mp_vision.RunningMode.IMAGE,
        num_faces=1,
        min_face_detection_confidence=0.5,
    )
    print("[INFO] MediaPipe face landmarker loaded")
    return mp_vision.FaceLandmarker.create_from_options(options)


# Created once at import, reused for every face crop
face_mesh = load_face_landmarker()

# Face mesh landmark indices (image-left / image-right as seen by the camera)
POSE_LANDMARKS = [
    1,    # nose tip
    152,  # chin
    33,   # left eye, outer corner
    263,  # right eye, outer corner
    61,   # left mouth corner
    291,  # right mouth corner
]

# Generic 3D face model in the same order (arbitrary units, nose at origin).
# Axes match OpenCV's camera frame (x right, y down, z away from camera), so a
# face looking straight at the camera solves to ~zero rotation.
FACE_MODEL_3D = np.array([
    (0.0, 0.0, 0.0),
    (0.0, 330.0, 65.0),
    (-225.0, -170.0, 135.0),
    (225.0, -170.0, 135.0),
    (-150.0, 150.0, 125.0),
    (150.0, 150.0, 125.0),
], dtype=np.float64)


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
# Firestore
# ---------------------------------------------------------------------------

def init_firestore(key_path):
    if not Path(key_path).exists():
        raise FileNotFoundError(f"Firebase service account key not found: {key_path}")
    firebase_admin.initialize_app(credentials.Certificate(str(key_path)))
    print("[INFO] Connected to Firestore")
    return firestore.client()


def commit_scores(db, scores_by_student, label):
    """Average each student's buffered scores and write one attendance_logs doc per student.

    Runs on the sync worker thread; errors are logged, never raised into the video loop.
    """
    if not scores_by_student:
        return
    try:
        items = list(scores_by_student.items())
        for start in range(0, len(items), FIRESTORE_BATCH_LIMIT):
            batch = db.batch()
            for student, scores in items[start:start + FIRESTORE_BATCH_LIMIT]:
                batch.set(db.collection("attendance_logs").document(), {
                    "student_name": student,
                    "status": "Present",
                    "attention_score": round(sum(scores) / len(scores), 1),
                    "timestamp": firestore.SERVER_TIMESTAMP,
                })
            batch.commit()
        summary = ", ".join(f"{s} ({len(v)} samples)" for s, v in items)
        print(f"[SYNC] {label}: pushed {len(items)} student(s) to Firestore: {summary}")
    except Exception as e:
        print(f"[ERROR] {label}: Firestore commit failed, {len(scores_by_student)} student(s) lost: {e}")


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


def padded_crop(frame, box):
    """Crop a YOLO box with CROP_PADDING margin, clipped to the frame. Returns (crop, x_offset, y_offset)."""
    x1, y1, x2, y2 = box
    h, w = frame.shape[:2]
    pad_x, pad_y = int((x2 - x1) * CROP_PADDING), int((y2 - y1) * CROP_PADDING)
    cx1, cy1 = max(0, x1 - pad_x), max(0, y1 - pad_y)
    cx2, cy2 = min(w, x2 + pad_x), min(h, y2 + pad_y)
    return frame[cy1:cy2, cx1:cx2], cx1, cy1


def landmarks_from_crop(app, frame, box):
    """Run InsightFace's detector on a padded YOLO crop to get 5 alignment landmarks."""
    crop, cx1, cy1 = padded_crop(frame, box)
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


def estimate_head_pose(frame, box):
    """MediaPipe landmarks + solvePnP on a face crop. Returns (pitch_deg, yaw_deg) or None."""
    # Face Mesh needs some forehead/chin margin, so use the padded crop, not the tight box
    crop, _, _ = padded_crop(frame, box)
    if crop.size == 0:
        return None

    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
    results = face_mesh.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    if not results.face_landmarks:
        return None

    h, w = crop.shape[:2]
    lm = results.face_landmarks[0]
    image_points = np.array([(lm[i].x * w, lm[i].y * h) for i in POSE_LANDMARKS], dtype=np.float64)

    # Pinhole approximation: focal length ~ crop width, principal point at crop centre, no distortion
    camera_matrix = np.array([
        [w, 0, w / 2],
        [0, w, h / 2],
        [0, 0, 1],
    ], dtype=np.float64)
    # SQPNP finds the global optimum. The generic face model fits real landmarks
    # loosely (~10px error), and ITERATIVE often falls into a second minimum at
    # ~27° pitch on a frontal face, wrongly flagging attentive students.
    ok, rvec, _ = cv2.solvePnP(
        FACE_MODEL_3D, image_points, camera_matrix, np.zeros((4, 1)),
        flags=cv2.SOLVEPNP_SQPNP,
    )
    if not ok:
        return None

    rot, _ = cv2.Rodrigues(rvec)
    # Rotation matrix -> Euler angles (x = pitch, y = yaw)
    pitch = math.degrees(math.atan2(rot[2, 1], rot[2, 2]))
    yaw = math.degrees(math.atan2(-rot[2, 0], math.hypot(rot[0, 0], rot[1, 0])))
    return pitch, yaw


def estimate_attention(frame, box):
    """0-100 attention score: 100 when facing the camera, minus points per degree of pitch/yaw."""
    pose = estimate_head_pose(frame, box)
    if pose is None:
        return FALLBACK_ATTENTION
    pitch, yaw = pose
    score = 100 - PITCH_PENALTY_PER_DEG * abs(pitch) - YAW_PENALTY_PER_DEG * abs(yaw)
    return max(0.0, min(100.0, score))


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
    db = init_firestore(args.key)

    source = int(args.source) if args.source.isdigit() else args.source
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video source: {args.source}")

    # Single worker keeps commits ordered and off the video thread
    sync_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="firestore-sync")
    minute_scores = {}  # student name -> list of attention scores in the current window
    window_idx = 1
    start_time = time.time()

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
                    minute_scores.setdefault(name, []).append(estimate_attention(frame, box))
                    now = time.monotonic()
                    if now - last_printed.get(name, -PRINT_COOLDOWN_SECONDS) >= PRINT_COOLDOWN_SECONDS:
                        print(f"Recognized: {name} (score {score:.2f}, frame {frame_idx})")
                        last_printed[name] = now

            # 60-second trigger: hand the buffer to the worker and start a fresh one
            current_time = time.time()
            if current_time - start_time >= SYNC_INTERVAL_SECONDS:
                sync_pool.submit(commit_scores, db, minute_scores, f"Minute {window_idx}")
                minute_scores = {}
                window_idx += 1
                start_time = current_time

            t_now = time.perf_counter()
            fps = 0.9 * fps + 0.1 * (1.0 / max(t_now - t_prev, 1e-6))
            t_prev = t_now

            if not args.no_display:
                next_sync = max(0, SYNC_INTERVAL_SECONDS - (current_time - start_time))
                hud = f"FPS {fps:.1f} | faces {len(detections)} | tracked {len(minute_scores)} | sync in {next_sync:.0f}s"
                cv2.putText(frame, hud, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 0), 2, cv2.LINE_AA)
                cv2.imshow("Dual-State Engine", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    print("[INFO] Quit requested")
                    break
    except KeyboardInterrupt:
        print("[INFO] Interrupted")
    finally:
        cap.release()
        cv2.destroyAllWindows()
        face_mesh.close()
        # Graceful exit: flush the partial window, then wait for all pending commits
        if minute_scores:
            print(f"[INFO] Flushing {len(minute_scores)} student(s) from partial window...")
            sync_pool.submit(commit_scores, db, minute_scores, f"Minute {window_idx} (final, partial)")
        sync_pool.shutdown(wait=True)
        print("[INFO] All data committed. Exiting.")


def parse_args():
    p = argparse.ArgumentParser(description="Dual-State Engine: face recognition + Firestore sync")
    p.add_argument("--source", default=str(SCRIPT_DIR / "test_video.mp4"),
                   help="Video file path, RTSP URL, or webcam index (e.g. 0)")
    p.add_argument("--photos", default=str(SCRIPT_DIR / "student_photos"),
                   help="Directory of enrollment .jpg files named after students")
    p.add_argument("--face-model", default=str(SCRIPT_DIR / "yolov8n-face.pt"),
                   help="YOLOv8 face detection weights")
    p.add_argument("--key", default=str(SCRIPT_DIR / "serviceAccountKey.json"),
                   help="Firebase service account key")
    p.add_argument("--threshold", type=float, default=MATCH_THRESHOLD,
                   help="Cosine similarity needed to accept a match")
    p.add_argument("--conf", type=float, default=0.5, help="YOLO detection confidence")
    p.add_argument("--no-display", action="store_true", help="Run headless (no OpenCV window)")
    return p.parse_args()


if __name__ == "__main__":
    run(parse_args())
