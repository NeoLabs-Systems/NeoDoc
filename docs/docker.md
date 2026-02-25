# Docker

## Quick start (docker-compose)

```bash
# 1. Copy and fill in the env file
cp .env.example .env
# Set JWT_SECRET to a long random string:
#   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# 2. Pull and start
docker compose up -d
```

Open **http://localhost:3000**, create your account.

The image is published automatically to `ghcr.io/neooriginal/documentneo:latest` on every push to `main`.

---

## Build locally

```bash
docker build -t documentneo .
docker compose up -d
```

Or uncomment `build: .` in `docker-compose.yml` and remove the `image:` line.

---

## Volumes

| Volume | Path | Purpose |
|---|---|---|
| `docneo_data` (named) | `/app/data` | SQLite database + uploaded files |
| `WATCH_FOLDER` (bind mount) | `/app/inbox` | Host folder the watcher ingests from |

`docneo_data` is a named Docker volume — managed by Docker and persists across restarts.

The inbox is a **bind mount**: whatever directory you set as `WATCH_FOLDER` in `.env` on the host
is mounted into the container at `/app/inbox`. Drop files there and they are auto-ingested.

```ini
# .env
WATCH_FOLDER=/home/neo/Pictures   # absolute path on the host
WATCH_ENABLED=true
```

If `WATCH_FOLDER` is not set, a local `./data/inbox/` folder next to `docker-compose.yml` is used.

To back up:

```bash
docker run --rm \
  -v documentneo_docneo_data:/data \
  -v $(pwd)/backup:/backup \
  alpine tar czf /backup/docneo-$(date +%Y%m%d).tar.gz /data
```

---

## Environment variables

All config is passed via environment variables. The `docker-compose.yml` reads them from your `.env` file automatically. See [.env.example](../.env.example) for the full reference.

---

## Updating

```bash
docker compose pull
docker compose up -d
```

---

## Reverse proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name docs.yourdomain.com;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        client_max_body_size 100M;
    }
}
```
