'use strict';

/**
 * NeoDoc MCP Server
 *
 * Implements the Model Context Protocol (2025-03-26 streamable HTTP transport)
 * so AI clients (Claude Desktop, Cursor, etc.) can access the vault.
 *
 * Endpoints:
 *   POST   /api/mcp                   – MCP JSON-RPC 2.0 (primary transport)
 *   GET    /api/mcp/oauth/authorize   – OAuth authorization page
 *   POST   /api/mcp/oauth/authorize   – Submit authorization form
 *   POST   /api/mcp/oauth/token       – Exchange code for access token
 *   POST   /api/mcp/oauth/register    – Dynamic client registration (RFC 7591)
 *   GET    /api/mcp/keys              – List API keys  (requires user JWT)
 *   POST   /api/mcp/keys              – Create API key (requires user JWT)
 *   DELETE /api/mcp/keys/:id          – Delete API key (requires user JWT)
 *
 *   Well-known metadata is served by index.js at:
 *   GET    /.well-known/oauth-authorization-server
 */

const express  = require('express');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db       = require('../database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

const sha256hex      = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sha256b64url   = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const escHtml        = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const sanitise       = (s, max = 500) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

function getSetting(key) {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) || {}).value ?? null;
}
function isMcpEnabled() {
  return getSetting('mcp_enabled') === 'true';
}
function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// ── MCP Authentication ────────────────────────────────────────────────────────
// Accepts both raw API keys (dneo_*) and OAuth access tokens.
// Returns { userId, username, role, scope } or null.

function resolveMcpUser(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const hash = sha256hex(token);

  // 1. API key
  const apiKey = db.prepare(`
    SELECT k.id, k.scope, k.user_id, u.username, u.role
    FROM mcp_api_keys k JOIN users u ON k.user_id = u.id
    WHERE k.key_hash = ?
  `).get(hash);
  if (apiKey) {
    db.prepare(
      `UPDATE mcp_api_keys SET last_used = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(apiKey.id);
    return { userId: apiKey.user_id, username: apiKey.username, role: apiKey.role, scope: apiKey.scope };
  }

  // 2. OAuth access token
  const oauthTok = db.prepare(`
    SELECT t.scope, t.user_id, t.expires_at, u.username, u.role
    FROM mcp_oauth_tokens t JOIN users u ON t.user_id = u.id
    WHERE t.token_hash = ?
  `).get(hash);
  if (oauthTok) {
    if (oauthTok.expires_at && new Date(oauthTok.expires_at) < new Date()) return null;
    return { userId: oauthTok.user_id, username: oauthTok.username, role: oauthTok.role, scope: oauthTok.scope };
  }

  return null;
}

function hasReadScope(scope)      { return scope === 'read'  || scope === 'readwrite'; }
function hasWriteScope(scope)     { return scope === 'write' || scope === 'readwrite'; }

// ── .well-known OAuth metadata (proxied from index.js) ───────────────────────
// Export a small helper so index.js can mount it at /.well-known/
function oauthMeta(req, res) {
  if (!isMcpEnabled()) return res.status(503).json({ error: 'MCP server is not enabled.' });
  const base = getBaseUrl(req);
  res.json({
    issuer:                                base,
    authorization_endpoint:                `${base}/api/mcp/oauth/authorize`,
    token_endpoint:                        `${base}/api/mcp/oauth/token`,
    registration_endpoint:                 `${base}/api/mcp/oauth/register`,
    scopes_supported:                      ['read', 'write', 'readwrite'],
    response_types_supported:              ['code'],
    grant_types_supported:                 ['authorization_code'],
    code_challenge_methods_supported:      ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}

// ── Dynamic client registration (RFC 7591) ────────────────────────────────────
router.post('/oauth/register', express.json({ limit: '16kb' }), (req, res) => {
  if (!isMcpEnabled()) return res.status(503).json({ error: 'MCP server is not enabled.' });

  const { client_name, redirect_uris, scope } = req.body ?? {};
  if (!client_name || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return res.status(400).json({ error: 'client_name and redirect_uris are required.' });
  }

  const VALID_SCOPES = ['read', 'write', 'readwrite'];
  const clientScope  = VALID_SCOPES.includes(scope) ? scope : 'read';

  // Security: only HTTPS or localhost redirect URIs allowed
  for (const uri of redirect_uris) {
    try {
      const u = new URL(uri);
      const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
      if (u.protocol !== 'https:' && !isLocal) {
        return res.status(400).json({ error: `Redirect URI must use HTTPS or be localhost: ${uri}` });
      }
    } catch {
      return res.status(400).json({ error: `Invalid redirect URI: ${uri}` });
    }
  }

  const clientId = `mcp_${crypto.randomBytes(16).toString('hex')}`;
  db.prepare(`
    INSERT OR IGNORE INTO mcp_oauth_clients (client_id, user_id, client_name, redirect_uris, scope)
    VALUES (?, 'system', ?, ?, ?)
  `).run(clientId, sanitise(client_name, 100), JSON.stringify(redirect_uris), clientScope);

  res.status(201).json({
    client_id:                    clientId,
    client_name:                  sanitise(client_name, 100),
    redirect_uris,
    scope:                        clientScope,
    grant_types:                  ['authorization_code'],
    response_types:               ['code'],
    token_endpoint_auth_method:   'none',
  });
});

// ── OAuth Authorization page (GET) ────────────────────────────────────────────
const SCOPE_INFO = {
  read:      { label: 'Read-only',    icon: '👁',  cls: 'read',      desc: 'View and search your documents' },
  write:     { label: 'Write',        icon: '✏️',  cls: 'write',     desc: 'Create, update and delete documents' },
  readwrite: { label: 'Read & Write', icon: '🔑', cls: 'readwrite', desc: 'Full access to your documents' },
};

const AUTH_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize – NeoDoc</title>
<link rel="stylesheet" href="/css/mcp-auth.css">
</head>
<body>
<div class="card">
  <div class="logo">🗂️</div>
  <h1>Authorize Access</h1>
  <p class="sub"><span class="client">__CLIENT_NAME__</span> wants to access your NeoDoc vault.</p>
  __ERROR__
  <div class="scope-box __SCOPE_CLS__">
    <div class="icon">__SCOPE_ICON__</div>
    <div>
      <div class="scope-label">__SCOPE_LABEL__</div>
      <div class="scope-desc">__SCOPE_DESC__</div>
    </div>
  </div>
  <div class="divider"></div>
  <form method="POST" action="/api/mcp/oauth/authorize">
    <input type="hidden" name="client_id"       value="__CLIENT_ID__">
    <input type="hidden" name="redirect_uri"    value="__REDIRECT_URI__">
    <input type="hidden" name="state"           value="__STATE__">
    <input type="hidden" name="scope"           value="__SCOPE__">
    <input type="hidden" name="code_challenge"  value="__CODE_CHALLENGE__">
    <label>Username</label>
    <input type="text"     name="username" autocomplete="username"         required placeholder="Your NeoDoc username">
    <label>Password</label>
    <input type="password" name="password" autocomplete="current-password" required placeholder="Your password">
    <div class="btns">
      <button type="submit" name="action" value="allow" class="btn-allow">Allow Access</button>
      <button type="submit" name="action" value="deny"  class="btn-deny">Deny</button>
    </div>
  </form>
  <p class="security-note">You are authorizing this client to access your account. You can revoke access at any time from Settings → MCP.</p>
</div>
</body>
</html>`;

function buildAuthPage(p, error = '') {
  const si    = SCOPE_INFO[p.scope] || SCOPE_INFO.read;
  const errEl = error ? `<div class="error">${escHtml(error)}</div>` : '';
  return AUTH_HTML
    .replace('__CLIENT_NAME__',  escHtml(p.clientName || p.client_id))
    .replace('__ERROR__',        errEl)
    .replace('__SCOPE_CLS__',    si.cls)
    .replace('__SCOPE_ICON__',   si.icon)
    .replace('__SCOPE_LABEL__',  si.label)
    .replace('__SCOPE_DESC__',   si.desc)
    .replace('__CLIENT_ID__',    escHtml(p.client_id))
    .replace('__REDIRECT_URI__', escHtml(p.redirect_uri))
    .replace('__STATE__',        escHtml(p.state || ''))
    .replace('__SCOPE__',        si.cls)
    .replace('__CODE_CHALLENGE__', escHtml(p.code_challenge));
}

router.get('/oauth/authorize', (req, res) => {
  if (!isMcpEnabled()) return res.status(503).send('<h1>MCP server is not enabled.</h1>');

  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = req.query;

  if (!client_id || !redirect_uri || !code_challenge) {
    return res.status(400).send('Missing required parameters: client_id, redirect_uri, code_challenge');
  }
  if (code_challenge_method && code_challenge_method !== 'S256') {
    return res.status(400).send('Only S256 code_challenge_method is supported.');
  }

  const client = db.prepare('SELECT * FROM mcp_oauth_clients WHERE client_id = ?').get(client_id);
  if (!client) return res.status(400).send('Unknown client_id. Please register your client first.');

  const allowed = JSON.parse(client.redirect_uris || '[]');
  if (!allowed.includes(redirect_uri)) return res.status(400).send('Redirect URI not registered for this client.');

  const finalScope = SCOPE_INFO[scope] ? scope : client.scope;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildAuthPage({
    client_id, clientName: client.client_name, redirect_uri, state, code_challenge, scope: finalScope,
  }));
});

router.post(
  '/oauth/authorize',
  express.urlencoded({ extended: false, limit: '10kb' }),
  async (req, res) => {
    if (!isMcpEnabled()) return res.status(503).send('<h1>MCP server is not enabled.</h1>');

    const { client_id, redirect_uri, state, code_challenge, scope, username, password, action } = req.body;

    const client = db.prepare('SELECT * FROM mcp_oauth_clients WHERE client_id = ?').get(client_id);
    if (!client) return res.status(400).send('Unknown client.');
    const allowed = JSON.parse(client.redirect_uris || '[]');
    if (!allowed.includes(redirect_uri)) return res.status(400).send('Invalid redirect_uri.');

    const rp = new URLSearchParams();
    if (state) rp.set('state', state);

    if (action === 'deny') {
      rp.set('error', 'access_denied');
      return res.redirect(`${redirect_uri}?${rp}`);
    }

    // Authenticate user against vault credentials
    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
    const ok   = user && await bcrypt.compare(String(password || ''), user.password);

    if (!ok) {
      const finalScope = SCOPE_INFO[scope] ? scope : client.scope;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(buildAuthPage({
        client_id, clientName: client.client_name, redirect_uri, state, code_challenge, scope: finalScope,
      }, 'Invalid username or password.'));
    }

    // Issue short-lived authorization code
    const finalScope = SCOPE_INFO[scope] ? scope : client.scope;
    const code       = crypto.randomBytes(32).toString('base64url');
    const expiresAt  = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO mcp_oauth_codes
        (code, user_id, client_id, scope, redirect_uri, code_challenge, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(code, user.id, client_id, finalScope, redirect_uri, code_challenge, expiresAt);

    rp.set('code', code);
    res.redirect(`${redirect_uri}?${rp}`);
  }
);

// ── OAuth Token endpoint ──────────────────────────────────────────────────────
router.post(
  '/oauth/token',
  express.json({ limit: '32kb' }),
  express.urlencoded({ extended: false, limit: '32kb' }),
  (req, res) => {
    if (!isMcpEnabled()) return res.status(503).json({ error: 'MCP server is not enabled.' });

    const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body ?? {};

    if (grant_type !== 'authorization_code') {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }
    if (!code || !redirect_uri || !client_id || !code_verifier) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'Missing required fields.' });
    }

    const authCode = db.prepare('SELECT * FROM mcp_oauth_codes WHERE code = ?').get(code);
    if (!authCode || authCode.used || authCode.client_id !== client_id || authCode.redirect_uri !== redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    if (new Date(authCode.expires_at) < new Date()) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired.' });
    }

    // PKCE S256 verification: challenge == BASE64URL(SHA256(verifier))
    const computed = sha256b64url(code_verifier);
    if (computed !== authCode.code_challenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' });
    }

    // Mark code as consumed (single-use)
    db.prepare('UPDATE mcp_oauth_codes SET used = 1 WHERE code = ?').run(code);

    // Issue long-lived access token (90-day expiry)
    const rawToken  = crypto.randomBytes(40).toString('base64url');
    const tokenExp  = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO mcp_oauth_tokens (id, user_id, client_id, scope, token_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), authCode.user_id, client_id, authCode.scope, sha256hex(rawToken), tokenExp);

    res.json({ access_token: rawToken, token_type: 'Bearer', scope: authCode.scope });
  }
);

// ── API Key CRUD (requires vault JWT auth) ────────────────────────────────────
router.get('/keys', requireAuth, (req, res) => {
  const keys = db.prepare(`
    SELECT id, name, key_prefix, scope, last_used, created_at
    FROM mcp_api_keys WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.user.id);
  res.json(keys);
});

router.post('/keys', requireAuth, express.json({ limit: '8kb' }), (req, res) => {
  const { name, scope } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Key name is required.' });
  }
  const VALID = ['read', 'write', 'readwrite'];
  if (!VALID.includes(scope)) {
    return res.status(400).json({ error: "scope must be 'read', 'write', or 'readwrite'." });
  }

  const count = db.prepare('SELECT COUNT(*) as n FROM mcp_api_keys WHERE user_id = ?').get(req.user.id);
  if (count.n >= 20) return res.status(400).json({ error: 'Maximum 20 API keys per user.' });

  const pfxChar  = { read: 'r', write: 'w', readwrite: 'rw' }[scope];
  const rawKey   = `dneo_${pfxChar}_${crypto.randomBytes(24).toString('base64url')}`;
  const prefix   = rawKey.slice(0, 14); // "dneo_r_xxxxxxx"
  const id       = uuidv4();

  db.prepare(`
    INSERT INTO mcp_api_keys (id, user_id, name, key_hash, key_prefix, scope)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, name.trim().slice(0, 100), sha256hex(rawKey), prefix, scope);

  res.status(201).json({
    id,
    name:        name.trim().slice(0, 100),
    key_prefix:  prefix,
    scope,
    created_at:  new Date().toISOString(),
    api_key:     rawKey,   // ← shown ONCE on creation, never stored in plaintext
  });
});

router.delete('/keys/:id', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM mcp_api_keys WHERE id = ? AND user_id = ?').run(
    req.params.id, req.user.id
  );
  if (r.changes === 0) return res.status(404).json({ error: 'Key not found.' });
  res.json({ success: true });
});

// Also expose OAuth tokens list / revoke
router.get('/oauth/tokens', requireAuth, (req, res) => {
  const tokens = db.prepare(`
    SELECT t.id, t.client_id, t.scope, t.created_at,
           c.client_name
    FROM mcp_oauth_tokens t
    LEFT JOIN mcp_oauth_clients c ON t.client_id = c.client_id
    WHERE t.user_id = ? ORDER BY t.created_at DESC
  `).all(req.user.id);
  res.json(tokens);
});

router.delete('/oauth/tokens/:id', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM mcp_oauth_tokens WHERE id = ? AND user_id = ?').run(
    req.params.id, req.user.id
  );
  if (r.changes === 0) return res.status(404).json({ error: 'Token not found.' });
  res.json({ success: true });
});

// ── MCP Tool Definitions ──────────────────────────────────────────────────────
const MCP_VERSION = '2025-03-26';
const WRITE_TOOLS = new Set([
  'documents_create', 'documents_update', 'documents_delete',
  'signing_create', 'signing_void',
]);

const TOOLS = [
  {
    name: 'documents_list',
    description: 'List documents in the vault with optional search query and filters.',
    inputSchema: {
      type: 'object',
      properties: {
        query:           { type: 'string',  description: 'Full-text search query' },
        tag_name:        { type: 'string',  description: 'Filter by tag name' },
        type_name:       { type: 'string',  description: 'Filter by document type name' },
        correspondent:   { type: 'string',  description: 'Filter by correspondent name' },
        limit:           { type: 'integer', description: 'Max results 1–50 (default 20)', minimum: 1, maximum: 50 },
        page:            { type: 'integer', description: 'Page number (default 1)', minimum: 1 },
      },
    },
  },
  {
    name: 'documents_get',
    description: 'Get full details of a document including its text content.',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: { id: { type: 'string', description: 'Document UUID' } },
    },
  },
  {
    name: 'documents_search',
    description: 'Full-text search across all documents.',
    inputSchema: {
      type: 'object', required: ['query'],
      properties: {
        query: { type: 'string',  description: 'Search query' },
        limit: { type: 'integer', description: 'Max results 1–50 (default 10)', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'tags_list',
    description: 'List all tags.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'types_list',
    description: 'List all document types.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'correspondents_list',
    description: 'List all correspondents.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'documents_create',
    description: '(Write scope required) Create a new text document in the vault.',
    inputSchema: {
      type: 'object', required: ['title', 'content'],
      properties: {
        title:   { type: 'string', description: 'Document title (max 255 chars)' },
        content: { type: 'string', description: 'Plain text content' },
        notes:   { type: 'string', description: 'Optional notes / summary' },
      },
    },
  },
  {
    name: 'documents_update',
    description: '(Write scope required) Update a document\'s title or notes.',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: {
        id:    { type: 'string', description: 'Document UUID' },
        title: { type: 'string', description: 'New title' },
        notes: { type: 'string', description: 'New notes' },
      },
    },
  },
  {
    name: 'documents_delete',
    description: '(Write scope required) Permanently delete a document.',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: { id: { type: 'string', description: 'Document UUID' } },
    },
  },

  // ── Signing tools ───────────────────────────────────────────────────────
  {
    name: 'signing_list',
    description: 'List signing envelopes. Optionally filter by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'draft | out_for_signature | completed | voided' },
        limit:  { type: 'integer', description: 'Max results 1–50 (default 20)', minimum: 1, maximum: 50 },
        page:   { type: 'integer', description: 'Page number (default 1)', minimum: 1 },
      },
    },
  },
  {
    name: 'signing_get',
    description: 'Get full details of a signing envelope including signers, fields, events, and doc fingerprint.',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: { id: { type: 'string', description: 'Envelope UUID' } },
    },
  },
  {
    name: 'signing_create',
    description: '(Write scope required) Create a draft signing envelope.',
    inputSchema: {
      type: 'object', required: ['title', 'signers'],
      properties: {
        title:       { type: 'string',  description: 'Envelope title (max 255 chars)' },
        message:     { type: 'string',  description: 'Optional message shown to signers' },
        document_id: { type: 'string',  description: 'Optional UUID of a vault document to attach' },
        signers: {
          type: 'array',
          description: 'Ordered list of signers',
          items: {
            type: 'object', required: ['name', 'email'],
            properties: {
              name:  { type: 'string', description: 'Full name' },
              email: { type: 'string', description: 'Email address' },
            },
          },
        },
      },
    },
  },
  {
    name: 'signing_void',
    description: '(Write scope required) Void an envelope (cannot be undone).',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: { id: { type: 'string', description: 'Envelope UUID' } },
    },
  },
];

// ── MCP Tool Executor ─────────────────────────────────────────────────────────
async function handleTool(name, args, userId) {
  const limit   = Math.min(Math.max(parseInt(args?.limit) || 20, 1), 50);
  const page    = Math.max(parseInt(args?.page) || 1, 1);
  const offset  = (page - 1) * limit;

  const ftsTerms = (raw) =>
    String(raw || '').replace(/["'*()@^]/g, ' ').replace(/\b(OR|AND|NOT|NEAR)\b/gi, ' ')
      .trim().slice(0, 200).split(/\s+/).filter(Boolean).slice(0, 15);

  switch (name) {
    case 'documents_list': {
      const where  = ['d.user_id = ?'];
      const params = [userId];

      const q = sanitise(args?.query, 200);
      if (q) {
        const terms = ftsTerms(q);
        if (terms.length) {
          where.push(`d.id IN (
            SELECT documents.id FROM documents
            INNER JOIN documents_fts ON documents.rowid = documents_fts.rowid
            WHERE documents_fts MATCH ?
          )`);
          params.push(terms.map(t => `"${t.replace(/"/g,'""')}"*`).join(' '));
        }
      }
      if (args?.tag_name) {
        where.push(`d.id IN (SELECT dt.document_id FROM document_tags dt
          JOIN tags t ON dt.tag_id = t.id WHERE LOWER(t.name) = LOWER(?) AND t.user_id = ?)`);
        params.push(sanitise(args.tag_name, 100), userId);
      }
      if (args?.type_name) {
        where.push(`d.type_id IN (SELECT id FROM document_types WHERE LOWER(name) = LOWER(?) AND user_id = ?)`);
        params.push(sanitise(args.type_name, 100), userId);
      }
      if (args?.correspondent) {
        where.push(`d.correspondent_id IN (SELECT id FROM correspondents WHERE LOWER(name) = LOWER(?) AND user_id = ?)`);
        params.push(sanitise(args.correspondent, 100), userId);
      }

      const whereSQL = where.join(' AND ');
      try {
        const rows = db.prepare(`
          SELECT d.id, d.title, d.filename, d.mime_type, d.file_size, d.created_at, d.updated_at,
                 dt.name AS type_name, c.name AS correspondent_name,
                 GROUP_CONCAT(tg.name, ', ') AS tags
          FROM documents d
          LEFT JOIN document_types dt ON d.type_id = dt.id
          LEFT JOIN correspondents c  ON d.correspondent_id = c.id
          LEFT JOIN document_tags dta ON d.id = dta.document_id
          LEFT JOIN tags tg ON dta.tag_id = tg.id
          WHERE ${whereSQL}
          GROUP BY d.id ORDER BY d.created_at DESC LIMIT ? OFFSET ?
        `).all(...params, limit, offset);
        const total = db.prepare(`SELECT COUNT(DISTINCT d.id) as n FROM documents d WHERE ${whereSQL}`)
          .get(...params).n;
        return { documents: rows, total, page, limit };
      } catch (e) {
        return { documents: [], total: 0, page, limit, _error: e.message };
      }
    }

    case 'documents_get': {
      const id  = sanitise(args?.id, 36);
      const doc = db.prepare(`
        SELECT d.id, d.title, d.filename, d.mime_type, d.file_size, d.notes,
               d.text_content, d.created_at, d.updated_at,
               dt.name AS type_name, c.name AS correspondent_name,
               GROUP_CONCAT(t.name, ', ') AS tags
        FROM documents d
        LEFT JOIN document_types dt ON d.type_id = dt.id
        LEFT JOIN correspondents c  ON d.correspondent_id = c.id
        LEFT JOIN document_tags dta ON d.id = dta.document_id
        LEFT JOIN tags t ON dta.tag_id = t.id
        WHERE d.id = ? AND d.user_id = ?
        GROUP BY d.id
      `).get(id, userId);
      if (!doc) return { error: 'Document not found.' };
      return doc;
    }

    case 'documents_search': {
      const raw   = sanitise(args?.query, 200);
      const terms = ftsTerms(raw);
      if (!terms.length) return { documents: [] };
      try {
        const rows = db.prepare(`
          SELECT d.id, d.title, d.filename, d.created_at, d.notes,
                 dt.name AS type_name, c.name AS correspondent_name
          FROM documents d
          INNER JOIN documents_fts fts ON d.rowid = fts.rowid
          LEFT JOIN document_types dt ON d.type_id = dt.id
          LEFT JOIN correspondents c  ON d.correspondent_id = c.id
          WHERE documents_fts MATCH ? AND d.user_id = ?
          ORDER BY d.created_at DESC LIMIT ?
        `).all(terms.map(t => `"${t.replace(/"/g,'""')}"*`).join(' '), userId, limit);
        return { documents: rows };
      } catch { return { documents: [] }; }
    }

    case 'tags_list':
      return { tags: db.prepare('SELECT id, name, color FROM tags WHERE user_id = ? ORDER BY name').all(userId) };

    case 'types_list':
      return { types: db.prepare('SELECT id, name, color FROM document_types WHERE user_id = ? ORDER BY name').all(userId) };

    case 'correspondents_list':
      return { correspondents: db.prepare('SELECT id, name, email FROM correspondents WHERE user_id = ? ORDER BY name').all(userId) };

    case 'documents_create': {
      const title   = sanitise(args?.title,   255);
      const content = typeof args?.content === 'string' ? args.content.slice(0, 500_000) : '';
      const notes   = sanitise(args?.notes, 2000);
      if (!title) return { error: 'title is required.' };
      if (!content) return { error: 'content is required.' };
      const id  = uuidv4();
      const buf = Buffer.from(content, 'utf8');
      db.prepare(`
        INSERT INTO documents
          (id, title, filename, mime_type, file_size, content, text_content, notes, user_id, source)
        VALUES (?, ?, ?, 'text/plain', ?, ?, ?, ?, ?, 'api')
      `).run(id, title, `${title.replace(/[^a-z0-9]/gi, '_').slice(0, 50)}.txt`, buf.length, buf, content, notes, userId);
      return { id, title, created: true };
    }

    case 'documents_update': {
      const id  = sanitise(args?.id, 36);
      const doc = db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?').get(id, userId);
      if (!doc) return { error: 'Document not found.' };
      const sets = [], vals = [];
      if (typeof args.title === 'string') { sets.push('title = ?'); vals.push(sanitise(args.title, 255)); }
      if (typeof args.notes === 'string') { sets.push('notes = ?'); vals.push(sanitise(args.notes, 2000)); }
      if (!sets.length) return { error: 'Nothing to update.' };
      sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
      db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals, id, userId);
      return { id, updated: true };
    }

    case 'documents_delete': {
      const id = sanitise(args?.id, 36);
      const r  = db.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').run(id, userId);
      if (r.changes === 0) return { error: 'Document not found.' };
      return { id, deleted: true };
    }

    // ── Signing tools ──────────────────────────────────────────────────────
    case 'signing_list': {
      const where  = ['e.user_id = ?'];
      const params = [userId];
      if (args?.status) {
        const VALID_S = ['draft', 'out_for_signature', 'completed', 'voided'];
        if (VALID_S.includes(args.status)) { where.push('e.status = ?'); params.push(args.status); }
      }
      const rows = db.prepare(`
        SELECT e.id, e.title, e.status, e.created_at, e.completed_at,
               COUNT(s.id)                                               AS signer_count,
               SUM(CASE WHEN s.status = 'signed' THEN 1 ELSE 0 END)     AS signed_count
        FROM sign_envelopes e
        LEFT JOIN sign_signers s ON s.envelope_id = e.id
        WHERE ${where.join(' AND ')}
        GROUP BY e.id ORDER BY e.created_at DESC LIMIT ? OFFSET ?
      `).all(...params, limit, offset);
      const total = db.prepare(
        `SELECT COUNT(*) as n FROM sign_envelopes e WHERE ${where.join(' AND ')}`
      ).get(...params).n;
      return { envelopes: rows, total, page, limit };
    }

    case 'signing_get': {
      const id  = sanitise(args?.id, 36);
      const env = db.prepare(
        `SELECT id, title, message, status, created_at, completed_at, doc_hash
         FROM sign_envelopes WHERE id = ? AND user_id = ?`
      ).get(id, userId);
      if (!env) return { error: 'Envelope not found.' };
      const signers = db.prepare(
        `SELECT id, name, email, status, signed_at, order_idx FROM sign_signers
         WHERE envelope_id = ? ORDER BY order_idx`
      ).all(id);
      const events = db.prepare(
        `SELECT action, ip, created_at FROM sign_events WHERE envelope_id = ? ORDER BY created_at`
      ).all(id);
      return { ...env, signers, events };
    }

    case 'signing_create': {
      const title     = sanitise(args?.title, 255);
      if (!title) return { error: 'title is required.' };
      const signersIn = Array.isArray(args?.signers) ? args.signers : [];
      if (!signersIn.length) return { error: 'At least one signer is required.' };
      for (const s of signersIn) {
        if (!s.name?.trim())  return { error: 'Every signer must have a name.' };
        if (!s.email?.trim()) return { error: 'Every signer must have an email.' };
      }
      if (args?.document_id) {
        const doc = db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?')
          .get(sanitise(args.document_id, 36), userId);
        if (!doc) return { error: 'Document not found.' };
      }
      const id = uuidv4();
      db.prepare(
        `INSERT INTO sign_envelopes (id, user_id, document_id, title, message)
         VALUES (?, ?, ?, ?, ?)`
      ).run(id, userId, args?.document_id || null, title, sanitise(args?.message || '', 2000));
      const COLOURS = ['#6366f1','#ec4899','#f59e0b','#22c55e','#06b6d4','#8b5cf6'];
      const outSigners = [];
      const insSigner = db.prepare(
        `INSERT INTO sign_signers (id, envelope_id, name, email, order_idx, token, color)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      signersIn.forEach((s, i) => {
        const sid   = uuidv4();
        const token = crypto.randomBytes(32).toString('hex');
        insSigner.run(sid, id, sanitise(s.name, 100), sanitise(s.email, 200), i,
          token, COLOURS[i % COLOURS.length]);
        outSigners.push({ id: sid, name: s.name, email: s.email });
      });
      return { id, title, status: 'draft', signers: outSigners };
    }

    case 'signing_void': {
      const id  = sanitise(args?.id, 36);
      const env = db.prepare(
        `SELECT id, status FROM sign_envelopes WHERE id = ? AND user_id = ?`
      ).get(id, userId);
      if (!env) return { error: 'Envelope not found.' };
      if (env.status === 'voided') return { error: 'Envelope is already voided.' };
      db.prepare(
        `UPDATE sign_envelopes SET status = 'voided',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).run(id);
      return { id, voided: true };
    }

    default:
      throw { code: -32601, message: `Unknown tool: ${name}` };
  }
}

// ── MCP JSON-RPC Endpoint ─────────────────────────────────────────────────────
router.post(
  '/',
  express.json({ limit: '4mb', strict: false }),
  async (req, res) => {
    if (!isMcpEnabled()) {
      return res.status(503).json({
        jsonrpc: '2.0', id: null,
        error: { code: -32000, message: 'MCP server is disabled. Enable it in Settings → MCP.' },
      });
    }

    const user = resolveMcpUser(req);
    if (!user) {
      return res.status(401)
        .set('WWW-Authenticate', `Bearer realm="NeoDoc MCP", error="invalid_token"`)
        .json({
          jsonrpc: '2.0', id: null,
          error: { code: -32000, message: 'Authentication required. Provide a valid Bearer API key or OAuth token.' },
        });
    }

    const body     = req.body;
    const batch    = Array.isArray(body);
    const messages = batch ? body : [body];
    const results  = [];

    for (const msg of messages) {
      const { jsonrpc, id = null, method, params } = msg ?? {};
      if (jsonrpc !== '2.0') {
        results.push({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
        continue;
      }

      try {
        switch (method) {
          case 'initialize':
            results.push({
              jsonrpc: '2.0', id,
              result: {
                protocolVersion: MCP_VERSION,
                capabilities:    { tools: { listChanged: false } },
                serverInfo:      { name: 'NeoDoc MCP', version: '1.0.0' },
              },
            });
            break;

          case 'notifications/initialized':
          case 'ping':
            // notifications have no id; pings echo empty result
            if (id !== undefined && id !== null) results.push({ jsonrpc: '2.0', id, result: {} });
            break;

          case 'tools/list':
            results.push({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
            break;

          case 'tools/call': {
            const toolName = params?.name;
            const toolArgs = params?.arguments ?? {};
            if (!toolName) {
              results.push({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing params.name' } });
              break;
            }
            if (WRITE_TOOLS.has(toolName) && !hasWriteScope(user.scope)) {
              results.push({ jsonrpc: '2.0', id, error: { code: -32000, message: 'This tool requires write scope.' } });
              break;
            }
            const toolResult = await handleTool(toolName, toolArgs, user.userId);
            results.push({
              jsonrpc: '2.0', id,
              result: {
                content:  [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
                isError:  Boolean(toolResult?.error),
              },
            });
            break;
          }

          default:
            results.push({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        }
      } catch (err) {
        results.push({
          jsonrpc: '2.0', id,
          error: { code: err.code || -32603, message: err.message || 'Internal error' },
        });
      }
    }

    res.json(batch ? results : results[0]);
  }
);

module.exports = { router, oauthMeta };
