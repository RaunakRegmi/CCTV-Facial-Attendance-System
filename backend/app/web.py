"""Serve the compiled React application from the same process as the API."""
from pathlib import Path
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

DEFAULT_DIST = Path(__file__).resolve().parents[2] / 'classroom-dashboard' / 'dist'


def mount_dashboard(app, directory=None):
    directory = Path(directory) if directory is not None else DEFAULT_DIST
    if not (directory / 'index.html').is_file():
        return  # API-only development; Vite proxies /api.

    @app.get('/', include_in_schema=False)
    def dashboard():
        return FileResponse(directory / 'index.html')

    # Explicit public routes: unknown API paths remain JSON 404s, never SPA HTML.
    @app.get('/favicon.svg', include_in_schema=False)
    def favicon():
        return FileResponse(directory / 'favicon.svg')

    @app.get('/theme-init.js', include_in_schema=False)
    def theme_script():
        return FileResponse(directory / 'theme-init.js', media_type='text/javascript')

    app.mount('/assets', StaticFiles(directory=directory / 'assets'), name='assets')
