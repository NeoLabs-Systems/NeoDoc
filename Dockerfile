# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
# sharp prebuilt binaries require libc6-compat on musl (Alpine)
RUN apk add --no-cache libc6-compat
COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine
# sharp prebuilt binaries require libc6-compat on musl (Alpine)
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Create non-root user
RUN addgroup -S docneo && adduser -S docneo -G docneo

# Copy deps + source
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Writable dirs for data and watch folder
RUN mkdir -p data/uploads inbox \
    && chown -R docneo:docneo /app

USER docneo

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "server/index.js"]
