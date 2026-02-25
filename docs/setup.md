# Setup Guide

## Requirements

- **Node.js** 18 or newer
- 512 MB RAM minimum (1 GB recommended with AI features)
- The port `3000` free (configurable via `PORT`)

---

## Installation

```bash
git clone https://github.com/neooriginal/documentneo
cd documentneo
npm install
cp .env.example .env
```

Edit `.env` — at minimum set `JWT_SECRET` to a long random string:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Then start:

```bash
npm start          # production
npm run dev        # development (auto-restarts on file changes)
```

Open **http://localhost:3000**, create your first account.

---

## Configuration

All options live in `.env` — see [.env.example](../.env.example) for the full reference.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | — | **Required.** Long random string |
| `JWT_EXPIRES_IN` | `24h` | Token lifetime |
| `DB_PATH` | `./data/vault.db` | SQLite database file path |
| `OPENAI_API_KEY` | — | Optional. Enables AI features |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model used for all AI tasks |
| `MAX_FILE_MB` | `50` | Per-upload file size limit |
| `ALLOWED_TYPES` | pdf, images, txt | MIME types allowed for upload |
| `WATCH_FOLDER` | `./inbox` | Auto-ingest folder path |
| `WATCH_ENABLED` | `false` | Enable/disable folder watcher |
| `REGISTRATION_OPEN` | `true` | Allow new account creation |

---

## AI Features

Set `OPENAI_API_KEY` in `.env`. All AI features work automatically after that:

- Documents are summarised and tagged on upload
- Correspondents are detected from document content
- **Ask AI** (sidebar) gives you a RAG chat over your entire archive
- Per-document AI assistant in the document viewer

To disable specific AI automations per-user, go to **Settings → AI Preferences**.

---

## Watch Folder

When `WATCH_ENABLED=true`, DocumentNeo watches `WATCH_FOLDER` for new files. Any supported file type dropped there is automatically uploaded, OCR'd (text extracted), and AI-processed.

```bash
WATCH_FOLDER=./inbox
WATCH_ENABLED=true
```

Useful for scanner integrations or automated pipelines.

---

## Data & Backups

All data is stored in a single SQLite file (`DB_PATH`) and uploaded files in `./data/uploads/`.

To back up:

```bash
cp -r data/ backup-$(date +%Y%m%d)/
```

To migrate to another machine, copy the entire `data/` directory and your `.env`.

---

## Document Signing

DocumentNeo has a built-in e-signature workflow. No third-party service is needed, but you need to configure SMTP so invitation emails can be sent.

SMTP is configured **per user** — go to **Settings → Email / SMTP** in the app and fill in your mail server details.

| Field | Example | Notes |
|---|---|---|
| SMTP host | `smtp.gmail.com` | Your mail server hostname |
| Port | `587` | 587 = STARTTLS, 465 = SSL |
| Username | `you@gmail.com` | SMTP login |
| Password | `•••••` | App password for Gmail/Outlook |
| From address | `Me <you@gmail.com>` | Display name + address |
| Security | `starttls` | `starttls`, `ssl`, or `none` |

Use the **Send Test Email** button in Settings to verify the connection before sending envelopes.

> Signing works without SMTP — use **Sign in Person** mode to have a signer sign directly on the device, with no email required.

---

## MCP Server

DocumentNeo ships a built-in MCP server for AI clients (Claude Desktop, Cursor, etc.).

1. Go to **Settings → MCP Server** and enable it.
2. Generate an API key (or use the OAuth flow for compatible clients).
3. Point your client at: `http://localhost:3000/api/mcp`

For Claude Desktop, add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "documentneo": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3000/api/mcp"],
      "env": { "MCP_API_KEY": "dneo_your_key_here" }
    }
  }
}
```

See [docs/api.md](api.md#mcp-server) for the full MCP API reference.

---

## Closing Registration

Once you have your accounts set up, lock registration:

```env
REGISTRATION_OPEN=false
```

Or toggle it in **Settings → Administration** inside the app.

---

## Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name docs.yourdomain.com;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection keep-alive;
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 100M;
    }
}
```

Increase `client_max_body_size` if you upload large files.
