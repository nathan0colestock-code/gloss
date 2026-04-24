# syntax=docker/dockerfile:1
FROM node:20-slim

# Poppler provides pdftoppm + pdfinfo used by the PDF ingest pipeline.
# ca-certificates so outbound HTTPS (Gemini, Google) works out of the box.
# rclone used by the daily scan-image sync to R2.
# curl needed to fetch the Litestream binary below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates curl rclone \
 && rm -rf /var/lib/apt/lists/*

# Litestream — continuous SQLite replication to R2 (S3-compatible).
# Pinned to a known-good release; bump deliberately when needed.
ARG LITESTREAM_VERSION=0.3.13
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64)  lsarch=amd64 ;; \
      arm64)  lsarch=arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-${lsarch}.tar.gz" \
      | tar -xz -C /usr/local/bin litestream; \
    chmod +x /usr/local/bin/litestream; \
    litestream version

WORKDIR /app

# Install production deps against the lockfile first to keep the layer cache
# from busting every time source changes. The sqlite-vec package ships its
# extension via optional per-platform subpackages; npm resolves the matching
# sqlite-vec-linux-x64 (or linux-arm64) at install time.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Sanity-check: fail the build loudly if the sqlite-vec prebuilt binary for
# this architecture is missing. Catches npm optionalDependencies regressions
# at build time instead of at first search query in prod.
RUN node -e "const p=require('sqlite-vec'); console.log('sqlite-vec binary OK:', p.getLoadablePath());"

# App source. .dockerignore keeps data/, tests/, scripts/, .git, etc. out.
COPY . .

ENV NODE_ENV=production \
    PORT=3747

EXPOSE 3747

# node-only healthcheck (slim image has no curl/wget on the Node side of the
# PATH lookup — but since curl is installed above for build, we keep this
# node-based check to avoid any PATH surprises at runtime).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3747)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Litestream wraps the Node process — on SIGTERM it syncs the final WAL page
# to R2 before exiting, so there's no restore-gap on deploys. If R2 env vars
# aren't set, Litestream still runs the exec'd process (it just logs replica
# errors and degrades to a no-op replicator).
CMD ["litestream", "replicate", "-exec", "node server.js", "-config", "/app/litestream.yml"]
