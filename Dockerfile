FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm AS backend
COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock README.md LICENSE .gitignore ./
RUN uv sync --locked --no-dev --no-install-project --no-build-package duckdb
COPY scripts/build_hook.py scripts/build_hook.py
COPY src/ src/
COPY --from=frontend /build/src/duckpad/static/ src/duckpad/static/
RUN uv sync --locked --no-dev --no-editable --no-build-package duckdb

FROM python:3.12-slim-bookworm AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 duckpad \
    && useradd --uid 10001 --gid duckpad --home-dir /data --create-home duckpad
WORKDIR /app
COPY --from=backend /app/.venv/ /app/.venv/
# Public previews use HTTPS even though the private proxy hop uses HTTP.
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 DUCKPAD_SECURE_COOKIES=1
USER duckpad
EXPOSE 8765
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/', timeout=4)"
CMD ["duckpad", "start", "--home", "/data/duckpad", "--host", "0.0.0.0", "--port", "8765", "--no-browser"]
