# Bonfire Connector Portal: React frontend and Python/FastAPI backend.
FROM node:24-slim AS web-build
WORKDIR /app

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

COPY package.json package-lock.json* ./
COPY web/package.json ./web/package.json
RUN npm config set proxy "${HTTP_PROXY}" \
    && npm config set https-proxy "${HTTPS_PROXY}" \
    && npm ci --workspace web --include-workspace-root \
    || npm install --workspace web --include-workspace-root
COPY web ./web
RUN npm run build --workspace web

FROM python:3.12-slim AS runtime
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/python \
    WEB_DIST=/app/web/dist \
    PORT=8100 \
    PORTAL_DATA_DIR=/state

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

COPY pyproject.toml requirements-python.txt ./
COPY python ./python
RUN http_proxy="${HTTP_PROXY}" https_proxy="${HTTPS_PROXY}" no_proxy="${NO_PROXY}" \
    pip install --no-cache-dir -r requirements-python.txt
COPY --from=web-build /app/web/dist ./web/dist

VOLUME ["/state"]
EXPOSE 8100
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=24 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/health', timeout=2)"
CMD ["uvicorn", "bonfire_portal.main:app", "--host", "0.0.0.0", "--port", "8100", "--workers", "1"]
