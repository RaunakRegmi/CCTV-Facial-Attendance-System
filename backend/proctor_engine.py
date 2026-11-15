import cv2
import time
import base64
import requests
import argparse
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
from ultralytics import YOLO

# --- Configuration ---
API_URL = "http://localhost:8080/api/exams/violations"
YAW_THRESHOLD = 35.0       # Degrees left/right before flagging
PITCH_DOWN_THRESHOLD = 25.0 # Degrees looking down (at lap/phone)
PERSISTENCE_SEC = 2.5      # Must violate for 2.5s continuously
COOLDOWN_SEC = 10.0        # Wait 10s before logging the same violation type again

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
    """Resizes frame to save Firestore bandwidth and encodes as JPEG base64."""
    small_frame = cv2.resize(frame, (640, 360))
    _, buffer = cv2.imencode('.jpg', small_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
    return f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

def report_violation(exam_id, violation_type, confidence, frame, details):
    payload = {
        "exam_id": exam_id,
        "violation_type": violation_type,
        "confidence": round(float(confidence), 2),
        "details": details,
        "evidence_snapshot": encode_frame_base64(frame)
    }
    try:
        res = requests.post(API_URL, json=payload, timeout=3)
        if res.status_code == 200:
            print(f"[ALERT SENT] {violation_type} | {details}")
        else:
            print(f"[API ERROR] {res.status_code}: {res.text}")
    except Exception as e:
        print(f"[NETWORK ERROR] Failed to reach FastAPI: {e}")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="0", help="0 for webcam or RTSP URL")
    parser.add_argument("--exam-id", default="CS-101-MIDTERM", help="Active Exam ID")
    args = parser.parse_args()

    # 1. Initialize YOLOv8n (Auto-downloads weights on first run)
    yolo_model = YOLO("yolov8n.pt")

    # 2. Initialize MediaPipe FaceLandmarker with 3D Transformation Matrix
    base_options = python.BaseOptions(model_asset_path="face_landmarker.task")
    options = vision.FaceLandmarkerOptions(
        base_options=base_options,
        output_facial_transformation_matrixes=True,
        num_faces=10,
        min_face_detection_confidence=0.5
    )
    landmarker = vision.FaceLandmarker.create_from_options(options)

    # 3. Open Video Stream
    source = int(args.source) if args.source.isdigit() else args.source
    cap = cv2.VideoCapture(source)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1) # Minimize RTSP buffer lag

    violation_timers = {"GAZE": None, "PHONE": None}
    last_reported = {"GAZE": 0, "PHONE": 0}

    print(f"Proctor Engine Active for Exam: {args.exam_id}")

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            print("Stream interrupted. Reconnecting...")
            time.sleep(1)
            continue

        now = time.time()
        annotated = frame.copy()

        # --- A. YOLOv8 Contraband & Person Detection ---
        # COCO classes: 0 = person, 67 = cell phone
        results = yolo_model(frame, classes=[0, 67], conf=0.45, verbose=False)
        phone_detected = False
        phone_conf = 0.0

        for r in results:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])
                x1, y1, x2, y2 = map(int, box.xyxy[0])

                if cls_id == 67:  # Cell Phone
                    phone_detected = True
                    phone_conf = max(phone_conf, conf)
                    cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 0, 255), 3)
                    cv2.putText(annotated, f"PHONE ({conf:.2f})", (x1, y1 - 10),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
                elif cls_id == 0: # Student
                    cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 255, 0), 1)

        # Phone Persistence & Reporting Logic
        if phone_detected:
            if violation_timers["PHONE"] is None:
                violation_timers["PHONE"] = now
            elif (now - violation_timers["PHONE"] >= PERSISTENCE_SEC) and (now - last_reported["PHONE"] >= COOLDOWN_SEC):
                report_violation(args.exam_id, "Contraband: Mobile Phone", phone_conf, annotated, "Unauthorized mobile device visible in frame.")
                last_reported["PHONE"] = now
                violation_timers["PHONE"] = None
        else:
            violation_timers["PHONE"] = None

        # --- B. MediaPipe Head-Pose / Gaze Tracking ---
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
        face_result = landmarker.detect(mp_image)

        suspicious_gaze = False
        gaze_details = ""

        if face_result.facial_transformation_matrixes:
            for idx, matrix in enumerate(face_result.facial_transformation_matrixes):
                pitch, yaw, roll = get_head_pose(np.array(matrix))

                # Check if looking far left/right or sharply down
                if abs(yaw) > YAW_THRESHOLD or pitch > PITCH_DOWN_THRESHOLD:
                    suspicious_gaze = True
                    gaze_details = f"Face #{idx+1} abnormal head pose (Yaw: {yaw:.1f}°, Pitch: {pitch:.1f}°)"
                    cv2.putText(annotated, f"SUSPICIOUS GAZE: Yaw {yaw:.0f}", (20, 40 + idx*30),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 165, 255), 2)

        # Gaze Persistence & Reporting Logic
        if suspicious_gaze:
            if violation_timers["GAZE"] is None:
                violation_timers["GAZE"] = now
            elif (now - violation_timers["GAZE"] >= PERSISTENCE_SEC) and (now - last_reported["GAZE"] >= COOLDOWN_SEC):
                report_violation(args.exam_id, "Suspicious Gaze / Head Turn", 0.90, annotated, gaze_details)
                last_reported["GAZE"] = now
                violation_timers["GAZE"] = None
        else:
            violation_timers["GAZE"] = None

        cv2.imshow("AI Exam Proctor Engine", annotated)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()