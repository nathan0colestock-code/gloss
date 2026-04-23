# syntax=docker/dockerfile:1
FROM node:20-slim

# Poppler provides pdftoppm + pdfinfo used by the PDF ingest pipeline.
# ca-certificates so outbound HTTPS (Gemini, Google) works out of the box.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps against the lockfile first to keep the layer cache
# from busting every time source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# App source. .dockerignore keeps data/, tests/, scripts/, .git, etc. out.
COPY . .

ENV NODE_ENV=production \
    PORT=3747

EXPOSE 3747

# node-only healthcheck (slim image has no curl/wget).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3747)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
