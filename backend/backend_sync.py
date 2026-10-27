import firebase_admin
from firebase_admin import credentials, firestore
import time
import random

cred = credentials.Certificate('serviceAccountKey.json')
firebase_admin.initialize_app(cred)
db = firestore.client()

def simulate_optimized_pipeline():
    print("--- STATE 2: Engagement Tracking (Optimized Batching) ---")
    detected_students = ["Raunak Regmi", "Teammate 2", "Teammate 3"]
    
    # Simulating a 45-minute class
    for minute in range(45):
        
        # 1. IN-MEMORY AGGREGATION
        # Store scores locally for the current minute instead of writing to cloud
        minute_scores = {student: [] for student in detected_students}
        
        # Simulating 60 frames (1 pose calculation per second)
        for second in range(60):
            for student in detected_students:
                # Simulating MediaPipe Head-Pose calculation
                simulated_pose_score = random.randint(60, 95)
                minute_scores[student].append(simulated_pose_score)
        
        # 2. FIRESTORE BATCH SETUP
        # Initialize a WriteBatch to group network calls
        batch = db.batch()
        
        for student, scores in minute_scores.items():
            # Calculate the 60-second average for the student
            avg_score = sum(scores) / len(scores)
            
            # Create a reference for a new document
            doc_ref = db.collection('attendance_logs').document()
            
            payload = {
                'student_name': student,
                'status': 'Present',
                'attention_score': round(avg_score, 1),
                'timestamp': firestore.SERVER_TIMESTAMP
            }
            
            # Queue the write operation into the batch
            batch.set(doc_ref, payload)
        
        # 3. COMMIT THE BATCH
        # Executes all writes in a single, atomic network request
        batch.commit()
        print(f"Minute {minute + 1}: Batched average scores pushed to Firestore.")
        
        # In the real script, this loop runs parallel to your OpenCV capture
        time.sleep(1) 

if __name__ == "__main__":
    simulate_optimized_pipeline()