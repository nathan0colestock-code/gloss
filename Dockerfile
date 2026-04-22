FROM node:20-slim

# Poppler provides pdftoppm + pdfinfo for PDF ingest.
# node:20-slim is Debian-based (glibc) which better-sqlite3 requires for its
# native bindings; alpine would need extra toolchain and is error-prone here.
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (separate layer for cache efficiency)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY server.js db.js ai.js google.js auth.js context.js ./
COPY seed-compass.js seed_roles_volume.js seed_compass_planning.js* ./
COPY scripts/ scripts/
COPY public/ public/

# /app/data is the Fly.io persistent volume mount point.
# Creating it here ensures the directory exists even without a volume.
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
