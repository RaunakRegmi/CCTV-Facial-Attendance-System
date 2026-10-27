from fastapi import Depends, HTTPException, Request
from firebase_admin import auth
from firebase_admin.exceptions import FirebaseError

COOKIE = 'attendance_session'


def current_user(request: Request):
    cookie = request.cookies.get(COOKIE)
    if not cookie:
        raise HTTPException(401, 'Sign in required')
    try:
        token = auth.verify_session_cookie(cookie, check_revoked=True, app=request.app.state.firebase)
    except (ValueError, FirebaseError) as exc:
        raise HTTPException(401, 'Session expired or invalid') from exc
    profile = request.app.state.repo.profile(token['uid'])
    if not profile or profile.get('disabled') is True or profile.get('role') not in ('admin', 'teacher'):
        raise HTTPException(403, 'Account has not been granted access')
    ids = profile.get('class_ids', [])
    if not isinstance(ids, list) or len(ids) > 100 or any(not isinstance(cid, str) or '/' in cid or not cid for cid in ids):
        raise HTTPException(403, 'Invalid access configuration')
    return {'uid': token['uid'], 'role': profile['role'], 'class_ids': ids}


def admin(user=Depends(current_user)):
    if user['role'] != 'admin':
        raise HTTPException(403, 'Administrator access required')
    return user


def authorize_class(user, class_id):
    if user['role'] != 'admin' and class_id not in user['class_ids']:
        raise HTTPException(403, 'Class access denied')
