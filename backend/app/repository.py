"""Firestore persistence. Browser clients never receive a database credential."""
from fastapi import HTTPException
from firebase_admin import firestore
from google.api_core.exceptions import AlreadyExists
from google.cloud.firestore_v1.base_query import FieldFilter

CLASS_FIELDS = ('class_id', 'class_name', 'room', 'start_time', 'last_active_startup', 'last_heartbeat', 'last_shutdown')
STUDENT_FIELDS = ('student_id', 'full_name', 'enrolled_classes')
LOG_FIELDS = ('student_name', 'status', 'attention_score', 'timestamp')


def project(doc, fields):
    data = doc.to_dict() or {}
    return {'id': doc.id, **{key: data[key] for key in fields if key in data}}


class Repository:
    def __init__(self, db):
        self.db = db

    def profile(self, uid):
        return self.db.collection('users').document(uid).get().to_dict()

    def classes(self, user):
        collection = self.db.collection('classes')
        if user['role'] == 'admin':
            docs = list(collection.limit(1001).stream())
            if len(docs) > 1000:
                raise HTTPException(409, 'Class listing exceeds capacity; contact administrator')
        else:
            docs = [collection.document(cid).get() for cid in user['class_ids']]
        return [project(d, CLASS_FIELDS) for d in docs if d.exists]

    def students(self, class_id=None):
        query = self.db.collection('students')
        if class_id:
            query = query.where(filter=FieldFilter('enrolled_classes', 'array_contains', class_id))
        docs = list(query.select(STUDENT_FIELDS).limit(1001).stream())
        if len(docs) > 1000:
            raise HTTPException(409, 'Roster exceeds capacity; contact administrator')
        return sorted([project(d, STUDENT_FIELDS) for d in docs], key=lambda d: d.get('full_name', ''))

    def logs(self, class_id, after=None):
        collection = self.db.collection('classes').document(class_id).collection('attendance_logs')
        query = collection.order_by('__name__')
        if after:
            query = query.start_after({'__name__': collection.document(after)})
        docs = list(query.limit(501).stream())
        return {'items': [project(d, LOG_FIELDS) for d in docs[:500]], 'next_cursor': docs[499].id if len(docs) > 500 else None}

    def create(self, collection, identifier, data, uid):
        ref = self.db.collection(collection).document(identifier)
        batch = self.db.batch()
        batch.create(ref, {**data, 'created_at': firestore.SERVER_TIMESTAMP})
        batch.create(self.db.collection('audit_events').document(), {
            'actor_uid': uid, 'action': 'create', 'resource': f'{collection}/{identifier}',
            'timestamp': firestore.SERVER_TIMESTAMP,
        })
        try:
            batch.commit()
        except AlreadyExists as exc:
            raise HTTPException(409, 'Record already exists') from exc

    def assert_classes(self, ids):
        if any(not self.db.collection('classes').document(cid).get().exists for cid in ids):
            raise HTTPException(422, 'An enrolled class does not exist')

    def delete_student(self, identifier, uid):
        batch = self.db.batch()
        batch.delete(self.db.collection('students').document(identifier))
        batch.create(self.db.collection('audit_events').document(), {
            'actor_uid': uid, 'action': 'delete', 'resource': f'students/{identifier}',
            'timestamp': firestore.SERVER_TIMESTAMP,
        })
        batch.commit()
