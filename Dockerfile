# RHEL 9 / UBI 9 Minimal based production image
# Multi-stage build keeps dependency and frontend cache invalidation independent.
FROM registry.access.redhat.com/ubi9/ubi-minimal AS base

# Keep the existing Python, Node.js, browser, and native runtime libraries.
RUN microdnf install -y --nodocs \
    python3.11 \
    python3.11-pip \
    python3.11-devel \
    gcc \
    gcc-c++ \
    libpq-devel \
    git \
    wget \
    ca-certificates \
    nodejs \
    npm \
    atk \
    at-spi2-atk \
    alsa-lib \
    cups-libs \
    gtk3 \
    libX11-xcb \
    libXcomposite \
    libXcursor \
    libXdamage \
    libXext \
    libXfixes \
    libXi \
    libXrandr \
    libXScrnSaver \
    libXtst \
    libdrm \
    libgbm \
    libxcb \
    pango \
    && microdnf clean all

RUN ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# uv and debugpy are installed once and carried into every application target.
RUN pip install --no-cache-dir --upgrade pip uv debugpy

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1


# Python dependency cache. Backend and frontend source changes do not invalidate it.
FROM base AS python-dependencies

COPY pyproject.toml uv.lock ./
ENV UV_PROJECT_ENVIRONMENT=/opt/venv
RUN uv sync --frozen --no-dev --no-install-project


# Frontend dependency/build cache. Python dependency changes do not invalidate it.
FROM base AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY frontend/public ./public
COPY frontend/src ./src
COPY frontend/config-overrides.js ./
RUN npm run build


# Runtime shared by both the clean-checkout and prebuilt-frontend image targets.
FROM base AS application-runtime

COPY --from=python-dependencies /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV UV_PROJECT_ENVIRONMENT=/opt/venv

ARG VISTA_BUILD_COMMIT=local
ARG VISTA_CI_PIPELINE_IID=0
LABEL org.opencontainers.image.revision="${VISTA_BUILD_COMMIT}" \
      io.vista.ci.pipeline-iid="${VISTA_CI_PIPELINE_IID}"

# Retain project metadata for diagnostics and optional CI dependency operations.
COPY pyproject.toml uv.lock ./
COPY backend /app/backend

ENV FRONTEND_BUILD_PATH=/app/ui2

WORKDIR /app
EXPOSE 8000

WORKDIR /app/backend
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]


# CI can reuse a separately built frontend artifact without rebuilding it here.
# The manifest makes accidental/stale artifact substitution fail the image build.
FROM application-runtime AS final-prebuilt

COPY frontend/build /app/ui2
COPY .ci-artifacts/frontend-build.sha256 /app/.ci-artifacts/frontend-build.sha256
COPY scripts/ci/frontend_build_manifest.sh /usr/local/bin/frontend_build_manifest
RUN sh /usr/local/bin/frontend_build_manifest verify \
        /app/ui2 \
        /app/.ci-artifacts/frontend-build.sha256 \
    && rm -f /usr/local/bin/frontend_build_manifest


# Default production target: reproducible from a clean checkout with no CI artifacts.
FROM application-runtime AS final

COPY --from=frontend-build /app/frontend/build /app/ui2
