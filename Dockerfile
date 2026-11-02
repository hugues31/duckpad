FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS website
WORKDIR /build/website
COPY website/package.json website/package-lock.json ./
RUN npm ci
COPY website/ ./
COPY docs/ /build/docs/
RUN WEBSITE_BASE_PATH=/site/ npm run build

# Prepared once on the preview server by scripts/provision-runtime.sh.
FROM duckpad-python:3.12-duckdb2.0.0 AS backend
WORKDIR /app
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock README.md LICENSE .gitignore ./
RUN uv sync --locked --no-dev --no-install-project --no-build-package duckdb \
    && .venv/bin/python -c "import duckdb; assert duckdb.__version__ == '2.0.0'"
COPY scripts/build_hook.py scripts/build_hook.py
COPY src/ src/
COPY --from=frontend /build/src/duckpad/static/ src/duckpad/static/
COPY --from=website /build/website/dist/ src/duckpad/static/site/
RUN uv sync --locked --no-dev --no-editable --no-build-package duckdb

FROM python:3.12-slim-bookworm AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates libstdc++6 \
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
