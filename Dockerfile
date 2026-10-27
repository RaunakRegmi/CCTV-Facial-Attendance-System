FROM node:22-bookworm-slim AS web
WORKDIR /build/classroom-dashboard
COPY classroom-dashboard/package*.json ./
RUN npm ci
COPY classroom-dashboard/ ./
RUN npm run build

FROM python:3.13-slim-bookworm AS app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 APP_ENV=production
WORKDIR /app
COPY backend/requirements-api.txt ./backend/requirements-api.txt
RUN pip install --no-cache-dir -r backend/requirements-api.txt && useradd --system --uid 10001 attendly
COPY backend/app ./backend/app
COPY --from=web /build/classroom-dashboard/dist ./classroom-dashboard/dist
USER attendly
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"]