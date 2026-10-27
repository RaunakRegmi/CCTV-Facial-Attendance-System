"""Environment-only configuration; production fails closed."""
import os
from dataclasses import dataclass
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Settings:
    project_id: str
    api_key: str
    origin: str
    secure_cookies: bool = True
    session_seconds: int = 28800

    @classmethod
    def from_env(cls):
        project = os.environ.get('FIREBASE_PROJECT_ID', '')
        key = os.environ.get('FIREBASE_WEB_API_KEY', '')
        origin = os.environ.get('APP_ORIGIN', '').rstrip('/')
        development = os.environ.get('APP_ENV') == 'development'
        parsed = urlsplit(origin)
        if not project or not key or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
            raise RuntimeError('Set FIREBASE_PROJECT_ID, FIREBASE_WEB_API_KEY and APP_ORIGIN')
        if parsed.scheme != 'https' and not (development and parsed.scheme == 'http' and parsed.hostname in {'localhost', '127.0.0.1'}):
            raise RuntimeError('APP_ORIGIN must use HTTPS (localhost allowed in development)')
        return cls(project, key, origin, not development)
