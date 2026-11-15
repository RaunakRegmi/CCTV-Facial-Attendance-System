"""
Identity-aware AI exam proctor.

Flags suspicious head pose (MediaPipe FaceLandmarker) and contraband
(YOLOv8), attributes each flag to an enrolled student via face_recognition,
and POSTs annotated evidence to the FastAPI write API (backend/api.py).

Run from anywhere (paths resolve relative to this file):
    python proctor_engine.py --source 0 --class-id CS-101 --exam-id CS-101-MIDTERM

Env:
    API_URL              base URL of backend/api.py (default: http://localhost:8080)
    SERVICE_ACCOUNT_KEY  path to the key (default: backend/serviceAccountKey.json)
"""

import os
import cv2
import time
import base64
import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
from ultralytics import YOLO
import face_recognition
import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter

# --- Configuration ---
BASE_DIR = Path(__file__).resolve().parent
# Same server as backend/api.py (uvicorn api:app --port 8080)
API_BASE_URL = os.environ.get("API_URL", "http://localhost:8080").rstrip("/")
API_URL = f"{API_BASE_URL}/api/exams/violations"
SERVICE_ACCOUNT_PATH = Path(os.environ.get("SERVICE_ACCOUNT_KEY", BASE_DIR / "serviceAccountKey.json"))

FACE_LANDMARKER_PATH = BASE_DIR / "face_landmarker.task"
FACE_LANDMARKER_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
CUSTOM_WEIGHTS_PATH = BASE_DIR / "contraband_yolov8n.pt"   # produced by train_contraband.py
FALLBACK_WEIGHTS_PATH = BASE_DIR / "yolov8n.pt"            # COCO; auto-downloaded by ultralytics

# Custom model classes (must match train_contraband.py / data.yaml)
CUSTOM_CLASSES = {0: "cell_phone", 1: "chit_paper", 2: "smartwatch", 3: "earbuds"}
# COCO fallback only knows phones
COCO_CLASSES = {67: "cell_phone"}
# Alert label + on-frame tag for each contraband class
CONTRABAND_LABELS = {
    "cell_phone": ("Contraband: Mobile Phone", "PHONE"),
    "chit_paper": ("Contraband: Chit Paper", "CHIT"),
    "smartwatch": ("Contraband: Smartwatch", "WATCH"),
    "earbuds": ("Contraband: Earbuds", "EARBUDS"),
}
CONTRABAND_CONF = 0.45

YAW_THRESHOLD = 35.0          # Degrees left/right before flagging
PITCH_DOWN_THRESHOLD = 25.0   # Degrees looking down
PERSISTENCE_SEC = 2.5         # Continuous violation duration required
COOLDOWN_SEC = 12.0           # Cooldown per student per violation type
FACE_MATCH_THRESHOLD = 0.50   # Lower = stricter match (0.45 - 0.55 recommended)
REID_INTERVAL_SEC = 2.0       # Re-verify identity every 2s to save CPU
CACHE_MATCH_PX = 80           # Max centroid drift to reuse a cached identity

UNIDENTIFIED = {"student_id": "UNIDENTIFIED", "name": "Unidentified Student"}


def init_firestore():
    if not SERVICE_ACCOUNT_PATH.exists():
        raise FileNotFoundError(f"Firebase service account key not found: {SERVICE_ACCOUNT_PATH}")
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(str(SERVICE_ACCOUNT_PATH)))
    return firestore.client()


def ensure_face_landmarker():
    """Downloads the MediaPipe face landmarker model if it's missing."""
    if FACE_LANDMARKER_PATH.exists():
        return
    print(f"[SETUP] {FACE_LANDMARKER_PATH.name} not found, downloading...")
    tmp_path = FACE_LANDMARKER_PATH.with_suffix(".task.part")
    with requests.get(FACE_LANDMARKER_URL, stream=True, timeout=30) as res:
        res.raise_for_status()
        with open(tmp_path, "wb") as f:
            for chunk in res.iter_content(chunk_size=1 << 16):
                f.write(chunk)
    # Rename only after a complete download so a partial file is never used
    tmp_path.replace(FACE_LANDMARKER_PATH)
    print(f"[SETUP] Saved {FACE_LANDMARKER_PATH}")


def pick_device():
    import torch
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def load_contraband_model():
    """Returns (model, class_map). Prefers custom weights, falls back to COCO."""
    if CUSTOM_WEIGHTS_PATH.exists():
        print(f"[MODEL] Using custom contraband weights: {CUSTOM_WEIGHTS_PATH.name}")
        return YOLO(str(CUSTOM_WEIGHTS_PATH)), CUSTOM_CLASSES
    print(f"[MODEL] {CUSTOM_WEIGHTS_PATH.name} not found; falling back to COCO yolov8n.pt (phones only)")
    return YOLO(str(FALLBACK_WEIGHTS_PATH)), COCO_CLASSES


def load_student_encodings(db, class_id):
    """Computes face encodings for students enrolled in class_id.

    Uses the same schema as api.py / attendly_engine.py: top-level `students`
    docs with full_name, student_id, photo_base64 and enrolled_classes.
    """
    known_encodings = []
    known_students = []

    docs = db.collection("students").where(
        filter=FieldFilter("enrolled_classes", "array_contains", class_id)
    ).stream()

    for doc in docs:
        data = doc.to_dict()
        student_id = data.get("student_id") or doc.id
        name = (data.get("full_name") or "").strip() or "Unknown Student"
        photo_b64 = data.get("photo_base64") or ""

        if not photo_b64:
            print(f"[WARN] No photo found for {name} ({student_id}), skipping.")
            continue

        try:
            if "," in photo_b64:
                photo_b64 = photo_b64.split(",", 1)[1]
            img_bytes = base64.b64decode(photo_b64)
            np_arr = np.frombuffer(img_bytes, np.uint8)
            bgr_img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            rgb_img = cv2.cvtColor(bgr_img, cv2.COLOR_BGR2RGB)

            encodings = face_recognition.face_encodings(rgb_img)
            if encodings:
                known_encodings.append(encodings[0])
                known_students.append({"student_id": student_id, "name": name})
                print(f"[ENROLLED] {name} ({student_id})")
            else:
                print(f"[WARN] Could not extract face features for {name} ({student_id})")
        except Exception as e:
            print(f"[ERROR] Failed decoding photo for {name}: {e}")

    print(f"Loaded {len(known_students)} student face profiles for class '{class_id}'.")
    return known_encodings, known_students


def identify_face_crop(rgb_frame, bbox, known_encodings, known_students):
    """Matches a detected face crop against enrolled student encodings."""
    if not known_encodings:
        return UNIDENTIFIED

    x1, y1, x2, y2 = bbox
    h, w, _ = rgb_frame.shape
    # Add 15% padding around landmarks box for accurate face_recognition encoding
    pad_x = int((x2 - x1) * 0.15)
    pad_y = int((y2 - y1) * 0.15)
    top = max(0, y1 - pad_y)
    right = min(w, x2 + pad_x)
    bottom = min(h, y2 + pad_y)
    left = max(0, x1 - pad_x)

    encodings = face_recognition.face_encodings(rgb_frame, [(top, right, bottom, left)])
    if not encodings:
        return UNIDENTIFIED

    distances = face_recognition.face_distance(known_encodings, encodings[0])
    best_idx = int(np.argmin(distances))
    if distances[best_idx] <= FACE_MATCH_THRESHOLD:
        return known_students[best_idx]

    return UNIDENTIFIED


def get_head_pose(transformation_matrix):
    """Extracts Pitch, Yaw, and Roll in degrees from MediaPipe's 4x4 matrix."""
    rmat = transformation_matrix[:3, :3]
    sy = np.sqrt(rmat[0, 0] ** 2 + rmat[1, 0] ** 2)
    singular = sy < 1e-6

    if not singular:
        pitch = np.arctan2(rmat[2, 1], rmat[2, 2])
        yaw = np.arctan2(-rmat[2, 0], sy)
        roll = np.arctan2(rmat[1, 0], rmat[0, 0])
    else:
        pitch = np.arctan2(-rmat[1, 2], rmat[1, 1])
        yaw = np.arctan2(-rmat[2, 0], sy)
        roll = 0

    return np.degrees(pitch), np.degrees(yaw), np.degrees(roll)


def encode_frame_base64(frame):
    small_frame = cv2.resize(frame, (640, 360))
    _, buffer = cv2.imencode(".jpg", small_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
    return f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"


def _post_violation(payload):
    try:
        res = requests.post(API_URL, json=payload, timeout=5)
        if res.ok:
            print(f"[ALERT SENT] {payload['student_name']} ({payload['student_id']}) -> {payload['violation_type']}")
        else:
            print(f"[API ERROR] {res.status_code}: {res.text}")
    except Exception as e:
        print(f"[NETWORK ERROR] Failed to reach FastAPI at {API_URL}: {e}")


# Alerts are POSTed off the capture thread so a slow API never drops frames
_dispatcher = ThreadPoolExecutor(max_workers=2, thread_name_prefix="alert")


def report_violation(exam_id, student, violation_type, confidence, frame, details):
    payload = {
        "exam_id": exam_id,
        "student_id": student["student_id"],
        "student_name": student["name"],
        "violation_type": violation_type,
        "confidence": round(float(confidence), 2),
        "details": details,
        # Encoded now: `frame` is overwritten by the next loop iteration
        "evidence_snapshot": encode_frame_base64(frame),
    }
    _dispatcher.submit(_post_violation, payload)


def open_capture(source):
    cap = cv2.VideoCapture(source)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="0", help="0 for webcam or RTSP URL")
    parser.add_argument("--class-id", default="CS-101", help="Firestore class ID for student roster")
    parser.add_argument("--exam-id", default="CS-101-MIDTERM", help="Active Exam ID")
    args = parser.parse_args()

    # 1. Load Student Roster & Face Encodings from Firestore
    db = init_firestore()
    known_encodings, known_students = load_student_encodings(db, args.class_id)

    # 2. Initialize YOLOv8 contraband detector & MediaPipe FaceLandmarker
    device = pick_device()
    yolo_model, contraband_classes = load_contraband_model()
    print(f"[MODEL] YOLO inference device: {device}")

    ensure_face_landmarker()
    base_options = python.BaseOptions(model_asset_path=str(FACE_LANDMARKER_PATH))
    options = vision.FaceLandmarkerOptions(
        base_options=base_options,
        output_facial_transformation_matrixes=True,
        num_faces=15,
        min_face_detection_confidence=0.5,
    )
    landmarker = vision.FaceLandmarker.create_from_options(options)

    # 3. Open Video Stream
    source = int(args.source) if args.source.isdigit() else args.source
    cap = open_capture(source)
    if not cap.isOpened():
        raise SystemExit(f"Could not open video source: {args.source}")

    # Lightweight spatial cache: maps face center (cx, cy) -> {student, last_checked}
    identity_cache = []
    violation_timers = {}  # key: (violation_type, student_id) -> start_time
    last_reported = {}     # key: (violation_type, student_id) -> timestamp

    print(f"Identity-Aware Proctor Engine Active | Class: {args.class_id} | Exam: {args.exam_id}")
    print("Press 'q' in the video window to quit.")

    while True:
        ret, frame = cap.read()
        if not ret:
            # RTSP streams drop; reopening is the only reliable recovery
            print("Stream interrupted. Reconnecting...")
            cap.release()
            time.sleep(1)
            cap = open_capture(source)
            continue

        now = time.time()
        h, w, _ = frame.shape
        annotated = frame.copy()
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        # --- A. MediaPipe Face Landmarks + Head Pose + Identity Resolution ---
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
        face_result = landmarker.detect(mp_image)

        tracked_faces = []  # List of dicts: {student, bbox, center, yaw, pitch}
        new_cache = []

        if face_result.face_landmarks and face_result.facial_transformation_matrixes:
            for landmarks, matrix in zip(
                face_result.face_landmarks,
                face_result.facial_transformation_matrixes,
            ):
                xs = [int(lm.x * w) for lm in landmarks]
                ys = [int(lm.y * h) for lm in landmarks]
                x1, y1, x2, y2 = max(0, min(xs)), max(0, min(ys)), min(w, max(xs)), min(h, max(ys))
                cx, cy = (x1 + x2) // 2, (y1 + y2) // 2

                # Reuse the nearest cached identity within CACHE_MATCH_PX so
                # face_recognition doesn't run on every face every frame
                matched_entry = None
                best_dist = CACHE_MATCH_PX
                for entry in identity_cache:
                    dist = np.hypot(cx - entry["cx"], cy - entry["cy"])
                    if dist < best_dist:
                        matched_entry, best_dist = entry, dist

                if (
                    matched_entry is None
                    or matched_entry["student"]["student_id"] == "UNIDENTIFIED"
                    or (now - matched_entry["last_checked"]) > REID_INTERVAL_SEC
                ):
                    student = identify_face_crop(rgb_frame, (x1, y1, x2, y2), known_encodings, known_students)
                    last_checked = now
                else:
                    student = matched_entry["student"]
                    last_checked = matched_entry["last_checked"]

                new_cache.append({"cx": cx, "cy": cy, "student": student, "last_checked": last_checked})

                pitch, yaw, _roll = get_head_pose(np.array(matrix))
                is_gaze_violation = abs(yaw) > YAW_THRESHOLD or pitch > PITCH_DOWN_THRESHOLD

                # Draw Student Identity & Head Pose Box
                box_color = (0, 165, 255) if is_gaze_violation else (0, 220, 120)
                cv2.rectangle(annotated, (x1, y1), (x2, y2), box_color, 2)
                label = f"{student['name']} ({student['student_id']})"
                cv2.putText(annotated, label, (x1, max(20, y1 - 10)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.55, box_color, 2)

                tracked_faces.append({
                    "student": student,
                    "bbox": (x1, y1, x2, y2),
                    "center": (cx, cy),
                    "yaw": yaw,
                    "pitch": pitch,
                    "is_gaze_violation": is_gaze_violation,
                })

        identity_cache = new_cache

        # Alerts are sent at the end of the frame so the evidence snapshot
        # includes every annotation (faces + contraband boxes)
        pending_alerts = []

        # Process Per-Student Gaze Violations
        active_gaze_keys = set()
        for face in tracked_faces:
            student = face["student"]
            key = ("GAZE", student["student_id"])
            if face["is_gaze_violation"]:
                active_gaze_keys.add(key)
                if key not in violation_timers:
                    violation_timers[key] = now
                elif (now - violation_timers[key] >= PERSISTENCE_SEC) and (
                    now - last_reported.get(key, 0) >= COOLDOWN_SEC
                ):
                    details = f"{student['name']} ({student['student_id']}) abnormal head pose (Yaw: {face['yaw']:.1f}°, Pitch: {face['pitch']:.1f}°)"
                    pending_alerts.append((student, "Suspicious Gaze / Head Turn", 0.90, details))
                    last_reported[key] = now
                    violation_timers.pop(key, None)

        # Clear timers for students who looked back at their paper
        for key in list(violation_timers.keys()):
            if key[0] == "GAZE" and key not in active_gaze_keys:
                violation_timers.pop(key, None)

        # --- B. YOLOv8 Contraband Detection + Nearest-Student Attribution ---
        results = yolo_model(
            frame,
            classes=list(contraband_classes),
            conf=CONTRABAND_CONF,
            device=device,
            verbose=False,
        )
        active_contraband_keys = set()

        for r in results:
            for box in r.boxes:
                cls_name = contraband_classes.get(int(box.cls[0]))
                if cls_name is None:
                    continue
                violation_type, tag = CONTRABAND_LABELS[cls_name]
                conf = float(box.conf[0])
                px1, py1, px2, py2 = map(int, box.xyxy[0])
                pcx, pcy = (px1 + px2) // 2, (py1 + py2) // 2

                # Attribute the item to the closest detected student face
                owner = UNIDENTIFIED
                if tracked_faces:
                    closest_face = min(
                        tracked_faces,
                        key=lambda f: np.hypot(pcx - f["center"][0], pcy - f["center"][1]),
                    )
                    owner = closest_face["student"]

                cv2.rectangle(annotated, (px1, py1), (px2, py2), (0, 0, 255), 3)
                cv2.putText(
                    annotated,
                    f"{tag}: {owner['name']} ({conf:.2f})",
                    (px1, max(20, py1 - 10)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6,
                    (0, 0, 255),
                    2,
                )

                key = (f"CONTRABAND:{cls_name}", owner["student_id"])
                if key in active_contraband_keys:
                    continue  # same item class near same student already handled this frame
                active_contraband_keys.add(key)

                if key not in violation_timers:
                    violation_timers[key] = now
                elif (now - violation_timers[key] >= PERSISTENCE_SEC) and (
                    now - last_reported.get(key, 0) >= COOLDOWN_SEC
                ):
                    item = cls_name.replace("_", " ")
                    details = f"Unauthorized {item} detected near {owner['name']} ({owner['student_id']})."
                    pending_alerts.append((owner, violation_type, conf, details))
                    last_reported[key] = now
                    violation_timers.pop(key, None)

        for owner, violation_type, conf, details in pending_alerts:
            report_violation(args.exam_id, owner, violation_type, conf, annotated, details)

        for key in list(violation_timers.keys()):
            if key[0].startswith("CONTRABAND:") and key not in active_contraband_keys:
                violation_timers.pop(key, None)

        cv2.imshow("AI Exam Proctor Engine (Identity-Aware)", annotated)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()
    landmarker.close()
    _dispatcher.shutdown(wait=True)  # let in-flight alerts finish


if __name__ == "__main__":
    main()