"""
Admin write API for the classroom dashboard.

The React app reads Firestore directly (onSnapshot), but every write goes
through here so the Firestore rules can deny all client writes. The Admin SDK
used below bypasses those rules.

Run from the backend/ folder:
    uvicorn api:app --reload --port 8000

Env:
    SERVICE_ACCOUNT_KEY  path to the key (default: backend/serviceAccountKey.json)
    CORS_ORIGINS         comma-separated allowed origins (default: http://localhost:5173)
"""

import os
from pathlib import Path
from typing import Annotated

import firebase_admin
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from firebase_admin import credentials, firestore
from google.api_core.exceptions import AlreadyExists
from google.cloud.firestore_v1.base_query import FieldFilter
from pydantic import AfterValidator, BaseModel, Field, StringConstraints

KEY_PATH = Path(os.environ.get("SERVICE_ACCOUNT_KEY", Path(__file__).parent / "serviceAccountKey.json"))
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(",")

# Firestore caps a document at 1 MiB; leave room for the other fields
# (matches MAX_PHOTO_CHARS in AdminPanel.jsx)
MAX_PHOTO_CHARS = 900_000

# ---------------------------------------------------------------------------
# Firestore
# ---------------------------------------------------------------------------

if not KEY_PATH.exists():
    raise FileNotFoundError(f"Firebase service account key not found: {KEY_PATH}")
if not firebase_admin._apps:  # uvicorn --reload re-imports this module
    firebase_admin.initialize_app(credentials.Certificate(str(KEY_PATH)))
db = firestore.client()

# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


def firestore_id(value: str) -> str:
    """Same rules as idError() in AdminPanel.jsx: a valid Firestore doc ID."""
    if "/" in value:
        raise ValueError('can\'t contain "/"')
    if value in (".", ".."):
        raise ValueError('can\'t be "." or ".."')
    if value.startswith("__") and value.endswith("__"):
        raise ValueError('can\'t start and end with "__"')
    return value


Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
DocId = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=100),
    AfterValidator(firestore_id),
]


class ClassIn(BaseModel):
    class_id: DocId
    class_name: Text
    room: Text | None = None


class StudentIn(BaseModel):
    full_name: Text
    student_id: DocId
    photo_base64: str = Field(pattern=r"^data:image/(jpeg|png|webp);base64,", max_length=MAX_PHOTO_CHARS)
    enrolled_classes: list[DocId] = Field(min_length=1)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="Classroom Attendance Admin API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["POST", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.post("/api/classes", status_code=status.HTTP_201_CREATED)
def create_class(body: ClassIn):
    ref = db.collection("classes").document(body.class_id)
    try:
        # create() fails if the doc exists, so an existing class (and the
        # engine's heartbeat fields on it) is never clobbered
        ref.create({
            "class_id": body.class_id,
            "class_name": body.class_name,
            "room": body.room,
            "status": "Stopped",
            "last_active_startup": None,
            "created_at": firestore.SERVER_TIMESTAMP,
        })
    except AlreadyExists:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Class {body.class_id} already exists.")
    return {"id": body.class_id}


@app.post("/api/students", status_code=status.HTTP_201_CREATED)
def create_student(body: StudentIn):
    students = db.collection("students")
    # Doc IDs are auto-generated, so student_id uniqueness is checked here.
    # Not atomic, but enrollment is a one-admin, low-traffic operation.
    taken = students.where(filter=FieldFilter("student_id", "==", body.student_id)).limit(1).get()
    if taken:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Student {body.student_id} is already enrolled.")

    _, ref = students.add({
        "full_name": body.full_name,
        "student_id": body.student_id,
        "photo_base64": body.photo_base64,
        "enrolled_classes": body.enrolled_classes,
        "created_at": firestore.SERVER_TIMESTAMP,
    })
    return {"id": ref.id}


@app.delete("/api/students/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_student(doc_id: DocId):
    # Past attendance logs are kept; they reference the name, not this doc
    db.collection("students").document(doc_id).delete()
