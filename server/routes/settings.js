'use strict';

const express = require('express');
const db      = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const SETTINGS_WRITE_ALLOWLIST = new Set([
  'openai_api_key',
  'ai_model',
  'ai_enabled',
  'app_name',
  'registration_open',
]);

function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

function upsertSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value);
}

/* GET /api/settings/public - public, no auth required */
router.get('/public', (_req, res) => {
  const storedApiKey = getSetting('openai_api_key');
  const hasStoredApiKey = !!(storedApiKey && storedApiKey !== '••••••••');
  res.json({
    app_name:          process.env.APP_NAME          || 'NeoDoc',
    ai_enabled:        process.env.OPENAI_API_KEY || hasStoredApiKey ? 'true' : 'false',
    registration_open: process.env.REGISTRATION_OPEN || 'true',
  });
});

/* GET /api/settings - admin-only */
router.get('/', requireAdmin, (_req, res) => {
  const openaiApiKey = getSetting('openai_api_key');
  const hasEnvKey = !!process.env.OPENAI_API_KEY;
  const hasStoredKey = !!(openaiApiKey && openaiApiKey !== '••••••••');
  res.json({
    ai_enabled: hasEnvKey || hasStoredKey ? 'true' : 'false',
    ai_model: getSetting('ai_model') || process.env.OPENAI_MODEL || 'gpt-5-mini',
    app_name: process.env.APP_NAME || getSetting('app_name') || 'NeoDoc',
    registration_open: process.env.REGISTRATION_OPEN || getSetting('registration_open') || 'true',
    openai_api_key: hasStoredKey ? '••••••••' : '',
    openai_api_key_source: hasEnvKey ? 'env' : (hasStoredKey ? 'settings' : 'none'),
  });
});

/* PUT /api/settings - admin-only */
router.put('/', requireAdmin, express.json({ limit: '16kb' }), (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const keys = Object.keys(body).filter((key) => SETTINGS_WRITE_ALLOWLIST.has(key));

  if (!keys.length) return res.json({ ok: true });

  for (const key of keys) {
    let value = body[key];
    if (value === undefined) continue;

    if (key === 'openai_api_key') {
      value = String(value || '').trim();
      upsertSetting(key, value);
      continue;
    }

    value = String(value ?? '').trim();
    upsertSetting(key, value);
  }

  res.json({ ok: true });
});

/* GET /api/settings/mcp — return mcp_enabled flag */
router.get('/mcp', requireAuth, (_req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'mcp_enabled'").get();
  res.json({ mcp_enabled: row?.value === 'true' });
});

/* PATCH /api/settings/mcp — toggle mcp_enabled (admin only) */
router.patch('/mcp', requireAdmin, express.json({ limit: '8kb' }), (req, res) => {
  const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('mcp_enabled', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(enabled ? 'true' : 'false');
  res.json({ mcp_enabled: enabled });
});

/* GET /api/settings/stats - admin-only */
router.get('/stats', requireAdmin, (_req, res) => {
  const docs  = db.prepare('SELECT COUNT(*) as n, SUM(file_size) as size FROM documents').get();
  const users = db.prepare('SELECT COUNT(*) as n FROM users').get();
  const audit = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 50').all();
  res.json({
    documents:       docs.n,
    total_size:      docs.size || 0,
    users:           users.n,
    recent_activity: audit,
  });
});

module.exports = router;
