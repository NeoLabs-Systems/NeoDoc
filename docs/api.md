# API Reference

All endpoints live under `/api`. Authentication uses a **Bearer JWT** token obtained from `/api/auth/login`.

```
Authorization: Bearer <token>
```

---

## Authentication

### `POST /api/auth/register`
Create a new account. Requires `REGISTRATION_OPEN=true`.

**Body:** `{ username, password }`  
**Returns:** `{ token, username, role }`

---

### `POST /api/auth/login`
**Body:** `{ username, password }`  
**Returns:** `{ token, username, role }`

---

### `GET /api/auth/me`
Returns the current user's profile and AI preferences.

---

### `PATCH /api/auth/me`
Update password or AI preference flags.

**Body:** `{ currentPassword?, newPassword?, pref_ai_auto_tag?, pref_ai_auto_type?, ... }`

---

## Documents

### `GET /api/documents`
List documents (paginated, filterable, sortable).

**Query params:**

| Param | Example | Description |
|---|---|---|
| `page` | `1` | Page number |
| `limit` | `24` | Results per page |
| `q` | `invoice` | Full-text search |
| `tag` | `tag-uuid` | Filter by tag |
| `type` | `type-uuid` | Filter by document type |
| `correspondent` | `corr-uuid` | Filter by correspondent |
| `sort` | `created_at` | Sort field |
| `order` | `desc` | `asc` or `desc` |

**Returns:** `{ documents: [...], total }`

---

### `POST /api/documents`
Upload a document. Send as `multipart/form-data`.

**Form fields:** `file` (required), `title` (optional)

---

### `GET /api/documents/:id`
Get a single document with tags, type, and correspondent.

---

### `PATCH /api/documents/:id`
Update metadata.

**Body:** `{ title?, notes?, type_id?, correspondent_id?, tags?: [id, ...] }`

---

### `DELETE /api/documents/:id`
Delete a single document and its file.

---

### `DELETE /api/documents`
Bulk delete.

**Body:** `{ ids: [uuid, ...] }`  
**Returns:** `{ message, deleted: count }`

---

### `GET /api/documents/:id/file`
Download the raw file. Returns the file stream with the original MIME type.

---

### `GET /api/documents/:id/view`
Same as `/file` but intended for inline preview (PDF/image). Returns a blob suitable for an `<iframe>` or `<img>` `src`.

---

## Tags

### `GET /api/tags` — list all tags
### `POST /api/tags` — create `{ name, color }`
### `PATCH /api/tags/:id` — update `{ name?, color? }`
### `DELETE /api/tags/:id` — delete

---

## Document Types

### `GET /api/types` — list all types
### `POST /api/types` — create `{ name, color }`
### `PATCH /api/types/:id` — update
### `DELETE /api/types/:id` — delete

---

## Correspondents

### `GET /api/correspondents` — list all
### `POST /api/correspondents` — create `{ name, color }`
### `PATCH /api/correspondents/:id` — update
### `DELETE /api/correspondents/:id` — delete

---

## AI

All AI endpoints require a valid `OPENAI_API_KEY` in `.env`.

### `POST /api/ai/chat`
RAG chat: searches all document content and answers the question.

**Body:** `{ question: string, history?: [{role, content}] }`  
**Returns:** `{ answer: string, sources: [{id, title}] }`

---

### `POST /api/ai/ask`
Ask a question about a **single document**.

**Body:** `{ documentId: uuid, question: string }`  
**Returns:** `{ answer: string }`

---

### `POST /api/ai/summarise`
Re-generate the summary for a document.

**Body:** `{ documentId: uuid }`  
**Returns:** `{ summary: string }`

---

### `POST /api/ai/retag`
Re-run auto-tagging on a document.

**Body:** `{ documentId: uuid }`  
**Returns:** `{ tags: [{ id, name, color }] }`

---

## Settings (admin only)

### `GET /api/settings` — all settings key/value pairs
### `PUT /api/settings` — update `{ key: value, ... }`
### `GET /api/settings/public` — subset visible to all authenticated users (ai_enabled, app_name)

---

## Document Signing

All sender endpoints require authentication. Public signer endpoints are token-gated (no login required).

### Envelopes

#### `GET /api/signing/envelopes`
List all envelopes for the authenticated user (includes signer counts).

---

#### `POST /api/signing/envelopes`
Create an envelope (saved as `draft`).

**Body:**
```json
{
  "document_id": "uuid",
  "title": "Contract Q1",
  "message": "Please review and sign.",
  "email_subject": "Action required: Contract Q1",
  "send_copy": true,
  "signers": [
    { "name": "Alice", "email": "alice@example.com" }
  ]
}
```

`document_id` is optional (envelope can be created without an attached document).  
`send_copy` — send the completed PDF to all signers when everyone has signed.  
`email_subject` — custom subject line for invitation emails (falls back to `Please sign: <title>`).

---

#### `GET /api/signing/envelopes/:id`
Get a single envelope including its signers and signing fields.

---

#### `PUT /api/signing/envelopes/:id`
Update a `draft` envelope (title, message, fields, signers).

**Body:** Same shape as `POST`.

---

#### `POST /api/signing/envelopes/:id/send`
Send invitation emails to all signers and transition status to `out_for_signature`.

---

#### `POST /api/signing/envelopes/:id/remind`
Re-send invitation emails to all signers who have not yet signed.

---

#### `POST /api/signing/envelopes/:id/void`
Void an envelope (all pending signatures cancelled).

---

#### `DELETE /api/signing/envelopes/:id`
Delete an envelope (allowed for `draft` and `voided` and `completed` envelopes).

---

#### `POST /api/signing/envelopes/:id/import`
Import the completed signed PDF back into the document vault as a new document.  
**Returns:** `{ documentId }`

---

#### `GET /api/signing/envelopes/:id/document`
Stream the original (unsigned) PDF attached to the envelope.

---

#### `GET /api/signing/envelopes/:id/download`
Download the completed signed PDF (only available after status is `completed`).

---

### Public Signer Endpoints

These endpoints are rate-limited and require no authentication — the signer token in the URL acts as the credential.

#### `GET /api/signing/public/:token`
Resolve a signer token. Returns envelope metadata and the signer's field definitions.

---

#### `GET /api/signing/public/:token/document`
Stream the PDF for the signer to view and sign.

---

#### `POST /api/signing/public/:token/submit`
Submit completed signature fields and seal the envelope PDF.

**Body:** `{ values: { [fieldId]: string } }`

---

### SMTP Configuration

#### `GET /api/signing/smtp`
Get the current user's SMTP settings (password is masked).

---

#### `PUT /api/signing/smtp`
Save SMTP settings for the current user.

**Body:**
```json
{
  "smtp_host": "smtp.example.com",
  "smtp_port": 587,
  "smtp_user": "user@example.com",
  "smtp_pass": "secret",
  "smtp_from": "My Name <user@example.com>",
  "smtp_secure": "starttls",
  "smtp_enabled": true
}
```
`smtp_secure`: `"starttls"` (port 587), `"ssl"` (port 465), or `"none"`.

---

#### `POST /api/signing/smtp/test`
Send a test email using the saved SMTP settings.

**Body:** `{ to: "test@example.com" }`

---

## MCP Server

The MCP server exposes the vault to AI clients via the [Model Context Protocol](https://modelcontextprotocol.io) (streamable HTTP transport, JSON-RPC 2.0).

**Endpoint:** `POST /api/mcp`

### Authentication

Two methods accepted in the `Authorization: Bearer <token>` header:

| Method | Format | How to obtain |
|---|---|---|
| API key | `dneo_…` | `POST /api/mcp/keys` |
| OAuth token | opaque | OAuth 2.0 PKCE flow via `/api/mcp/oauth/*` |

### API Key management

#### `GET /api/mcp/keys` — list keys (requires user JWT)
#### `POST /api/mcp/keys` — create key — body: `{ name, scope? }` — returns `{ key, id }`
#### `DELETE /api/mcp/keys/:id` — revoke a key

### OAuth endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/mcp/oauth/authorize` | Authorization page |
| `POST /api/mcp/oauth/authorize` | Submit authorization |
| `POST /api/mcp/oauth/token` | Exchange code for access token |
| `POST /api/mcp/oauth/register` | Dynamic client registration (RFC 7591) |
| `GET /.well-known/oauth-authorization-server` | OAuth server metadata |

### Available tools

| Tool | Description |
|---|---|
| `documents_list` | List documents (paginated, filterable) |
| `documents_get` | Get a single document by ID |
| `documents_search` | Full-text search across all documents |
| `documents_create` | Upload a new document (base64 file) |
| `documents_update` | Update document metadata |
| `documents_delete` | Delete a document |
| `tags_list` | List all tags |
| `types_list` | List all document types |
| `correspondents_list` | List all correspondents |

Enable / disable the MCP server in **Settings → MCP Server** inside the app.

---

## Error format

All errors return JSON:

```json
{ "error": "Human-readable message" }
```

Common HTTP status codes: `400` bad input, `401` unauthenticated, `403` forbidden, `404` not found, `429` rate limited, `500` server error.
