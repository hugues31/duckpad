FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm AS backend
COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends g++ make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never CMAKE_BUILD_PARALLEL_LEVEL=2
# DuckDB 2.0's published wheel crashes on the preview server's Ivy Bridge CPU.
# Build the same locked version for baseline x86-64 instead of downgrading it.
ENV CFLAGS="-march=x86-64 -mtune=generic" CXXFLAGS="-march=x86-64 -mtune=generic"
COPY pyproject.toml uv.lock README.md LICENSE .gitignore ./
RUN uv sync --locked --no-dev --no-install-project --no-binary-package duckdb
COPY scripts/build_hook.py scripts/build_hook.py
COPY src/ src/
COPY --from=frontend /build/src/duckpad/static/ src/duckpad/static/
RUN uv sync --locked --no-dev --no-editable --no-binary-package duckdb

FROM python:3.12-slim-bookworm AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 duckpad \
    && useradd --uid 10001 --gid duckpad --home-dir /data --create-home duckpad
WORKDIR /app
COPY --from=backend /app/.venv/ /app/.venv/
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
USER duckpad
EXPOSE 8765
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/', timeout=4)"
CMD ["duckpad", "start", "--home", "/data/duckpad", "--host", "0.0.0.0", "--port", "8765", "--no-browser"]
