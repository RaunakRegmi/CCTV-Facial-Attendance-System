# Dual-State Vision Analytics: Privacy-First Classroom Intelligence Platform

An end-to-end, edge-accelerated computer vision and real-time dashboard platform designed to automate classroom attendance and quantify real-time engagement while prioritizing biometric privacy.

---

## Key Features & Innovations

- **Dual-State Architecture for Privacy**
  - **Phase 1 — Identity Verification (First 5 Minutes):** Hardware-accelerated facial identification using facial embeddings.
  - **Phase 2 — Anonymous Attention Tracking (Remainder of Session):** Transitions to geometric head-pose estimation and spatial orientation tracking. Facial identification is disabled after the initial window, and no new facial identities are logged during this phase.

- **Zero-Storage Cloud Sync:** Encodes resized biometric reference photos as Base64 directly in Google Firestore, avoiding a separate cloud object-storage dependency.

- **Hardware Acceleration:** Apple Silicon optimization using PyTorch Metal Performance Shaders (MPS), with support for compatible CUDA GPUs where configured.

- **Real-Time React Dashboard:** Live system status, attendance tracking, engagement timelines, dark/light themes, and sanitized CSV report exports.

- **Session-Scoped Analytics:** Edge heartbeat monitoring and automated session-boundary tracking help prevent historical attendance records from distorting live session metrics.

---

## System Architecture

```text
+-----------------------------------------------------------------------+
|                       REACT DASHBOARD (UI)                            |
|                                                                       |
|  +----------------+  +-------------------+  +---------------------+   |
|  | Admin Panel    |  | Live Analytics    |  | CSV Exporter        |   |
|  | Student        |  | Session-Scoped    |  | UTF-8 Sanitization  |   |
|  | Enrollment     |  | Metrics           |  |                     |   |
|  +-------+--------+  +---------^---------+  +---------------------+   |
+----------|---------------------|--------------------------------------+
           |                     |
           | Direct Writes       | Real-Time Subscription
           |                     | (onSnapshot)
+----------|---------------------|--------------------------------------+
|                         FIREBASE FIRESTORE                            |
|                                                                       |
|  +----------------------+       +----------------------------------+  |
|  | /students            |       | /classes/{class_id}              |  |
|  | - full_name          |       | - status                         |  |
|  | - photo_base64       |       | - last_active_startup             |  |
|  | - enrolled_classes   |       | - /attendance_logs                |  |
|  +----------^-----------+       +----------------^-----------------+  |
+-------------|------------------------------------|--------------------+
              |                                    |
              | Roster & Reference Photos          | Batched Writes
              | on Engine Startup                  | Heartbeat / Shutdown
+-------------|------------------------------------|--------------------+
|                        PYTHON AI ENGINE (EDGE)                       |
|                                                                       |
|  +-------------------+  +--------------------+  +------------------+  |
|  | YOLOv8 Face /     |->| InsightFace ArcFace|->| MediaPipe        |  |
|  | Pose Detection    |  | Face Embeddings    |  | Face Mesh        |  |
|  +-------------------+  +--------------------+  +--------+---------+  |
|                                                          |            |
|                    STATE 1: IDENTITY VERIFICATION        |            |
|                    STATE 2: ANONYMOUS ATTENTION TRACKING |            |
|                                                          v            |
|                                               Head Pose & 3D Geometry |
+-----------------------------------------------------------------------+
```

---

## Tech Stack

| Domain                | Technologies                                                  |
| --------------------- | ------------------------------------------------------------- |
| Frontend              | React, Tailwind CSS, Recharts, Lucide Icons, Vite             |
| Edge AI Engine        | Python 3.10+, PyTorch, OpenCV, InsightFace, YOLOv8, MediaPipe |
| Hardware Acceleration | Apple Metal Performance Shaders (MPS), compatible CUDA GPUs   |
| Cloud Infrastructure  | Firebase Firestore, real-time document subscriptions          |
| Development Tools     | Git, npm, Python virtual environments                         |
| Target Hardware       | Apple Silicon (M1/M2/M3/M4) and compatible GPU systems        |

---

## Getting Started

### Prerequisites

- Node.js v18 or higher
- Python 3.10 or higher
- npm
- A Firebase project with Cloud Firestore enabled
- A compatible webcam or video source
- Compatible model weights for face detection

### 1. Clone the Repository

Replace `YOUR_USERNAME` with your GitHub username.

```bash
git clone https://github.com/YOUR_USERNAME/dual-state-classroom-analytics.git
cd dual-state-classroom-analytics
```

### 2. Set Up the Frontend

```bash
cd classroom-dashboard
npm install
cp .env.example .env
```

Configure your Firebase credentials in `.env`:

```env
VITE_FIREBASE_API_KEY=YOUR_API_KEY
VITE_FIREBASE_AUTH_DOMAIN=YOUR_PROJECT.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=YOUR_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET=YOUR_PROJECT.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=YOUR_SENDER_ID
VITE_FIREBASE_APP_ID=YOUR_APP_ID
```

Replace the placeholder values with the configuration from your Firebase project.

Start the development server:

```bash
npm run dev
```

Open the local URL displayed in your terminal, typically:

```text
http://localhost:5173
```

### 3. Set Up the Python AI Engine

Open a separate terminal from the repository root:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

**macOS/Linux:** Use the activation command above. On Windows, activate the environment with:

```powershell
.venv\Scripts\activate
```

### 4. Configure Firebase

Before running the engine:

1. Create a Firebase project.
2. Enable Cloud Firestore.
3. Configure the frontend Firebase environment variables.
4. Set up the appropriate backend Firebase credentials using your project's supported authentication method.
5. Configure Firestore security rules and access permissions.
6. Ensure the student collection, class documents, and attendance-log structure match the application's implementation.

Never commit private service-account JSON files, API secrets, or other credentials to GitHub.

---

## Running the Platform

### Step 1: Create a Class and Enroll Students

1. Start the React dashboard.
2. Open `http://localhost:5173`.
3. Navigate to the Admin Panel.
4. Create a class, for example, `CS-101`.
5. Add a student, provide the required details, upload a reference face photo, and assign the student to the class.
6. Save the student record.

### Step 2: Start the Dual-State AI Engine

From the backend directory, activate the virtual environment and run:

```bash
python3 dual_state_engine.py --source 0 --class-id CS-101 --threshold 0.45
```

This example uses webcam device `0` and targets the `CS-101` class.

### CLI Options

| Argument       | Description                            | Example              |
| -------------- | -------------------------------------- | -------------------- |
| `--source`     | Webcam device index or video-file path | `0` or `lecture.mp4` |
| `--class-id`   | Target class document ID in Firestore  | `CS-101`             |
| `--threshold`  | Facial similarity threshold            | `0.45`               |
| `--face-model` | Path to face-detection model weights   | `yolov8n-face.pt`    |

Use the exact argument names and supported values implemented by your engine. The examples above assume the described CLI options are available.

---

## Privacy & Security

### 1. Dual-State Identity Boundary

Facial identification is intended to run locally during the initial five-minute window. After that window, the system transitions to geometric attention tracking without continuing facial identity matching.

The privacy guarantee depends on the implementation: ensure face embeddings, temporary frames, and identity associations are cleared or restricted appropriately when the state changes.

### 2. Client-Side Image Resizing

Reference images are resized to approximately `400 × 400` pixels before being encoded as Base64 and submitted to Firestore.

This reduces upload size but does **not** make biometric data anonymous or eliminate the sensitivity of the stored images.

### 3. CSV Formula-Injection Protection

CSV exports should sanitize untrusted values that could be interpreted as spreadsheet formulas, including values beginning with `=`, `+`, `-`, or `@`.

Sanitization should be applied consistently to exported text fields and tested against spreadsheet applications.

### 4. Credential and Database Security

- Keep credentials out of source control.
- Restrict Firestore access using authentication and security rules.
- Avoid exposing privileged service-account credentials in the frontend.
- Apply data minimization and retention policies to biometric references and attendance records.
- Obtain appropriate consent and follow applicable privacy requirements before collecting student biometric data.

### 5. Honest Privacy Boundaries

Base64 is an encoding format, **not encryption**. Storing images as Base64 in Firestore avoids a separate object-storage service, but the biometric data remains sensitive and must be protected through appropriate access controls, encryption, and retention policies.

---

## Future Improvements

Potential extensions include:

- More robust head-pose estimation under varying lighting conditions.
- Improved edge inference performance and resource monitoring.
- Configurable session durations and identity-verification windows.
- More comprehensive privacy auditing and data-retention controls.
- Evaluation of attendance accuracy and engagement-estimation reliability.
- Role-based dashboard access and improved audit logging.
