"""
Capture CCTV/webcam frames for contraband YOLO training.

Controls (focus the OpenCV window):
    SPACE  start / pause capturing (one frame every 0.5 s while active)
    q/ESC  quit

Usage:
    python capture_dataset.py --source 0
    python capture_dataset.py --source rtsp://user:pass@cam-ip/stream --output-dir yolo_contraband/raw_frames

Relative --output-dir paths resolve against this file's folder (backend/),
so frames land where train_contraband.py expects them.
"""

import argparse
import time
from datetime import datetime
from pathlib import Path

import cv2

BASE_DIR = Path(__file__).resolve().parent
CAPTURE_INTERVAL_SEC = 0.5
WINDOW = "Dataset Capture (SPACE: toggle, q: quit)"


def open_capture(source):
    cap = cv2.VideoCapture(source)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", default="0", help="Webcam index or RTSP URL")
    parser.add_argument("--output-dir", default="yolo_contraband/raw_frames", help="Where JPEG frames are saved")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        output_dir = BASE_DIR / output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    source = int(args.source) if args.source.isdigit() else args.source
    cap = open_capture(source)
    if not cap.isOpened():
        raise SystemExit(f"Could not open video source: {args.source}")

    capturing = False
    last_saved = 0.0
    saved_count = 0
    print(f"Saving frames to {output_dir}")
    print("Press SPACE to start/pause capturing, q or ESC to quit.")

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("Stream interrupted. Reconnecting...")
                cap.release()
                time.sleep(1)
                cap = open_capture(source)
                continue

            now = time.time()
            if capturing and now - last_saved >= CAPTURE_INTERVAL_SEC:
                # Timestamped names never collide across sessions
                name = datetime.now().strftime("frame_%Y%m%d_%H%M%S_%f.jpg")
                cv2.imwrite(str(output_dir / name), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
                last_saved = now
                saved_count += 1

            # Overlay is drawn on a copy so saved frames stay clean
            preview = frame.copy()
            status = "REC" if capturing else "PAUSED"
            color = (0, 0, 255) if capturing else (160, 160, 160)
            cv2.circle(preview, (24, 28), 9, color, -1)
            cv2.putText(preview, f"{status}  |  saved: {saved_count}", (42, 36),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
            cv2.imshow(WINDOW, preview)

            key = cv2.waitKey(1) & 0xFF
            if key == ord(" "):
                capturing = not capturing
                print("Capturing..." if capturing else f"Paused ({saved_count} frames saved)")
            elif key in (ord("q"), 27):
                break
    finally:
        cap.release()
        cv2.destroyAllWindows()

    print(f"Done. {saved_count} frames saved to {output_dir}")


if __name__ == "__main__":
    main()
