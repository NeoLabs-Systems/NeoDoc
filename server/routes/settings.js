'use strict';

const express = require('express');
const db      = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/* GET /api/settings/public - public, no auth required */
router.get('/public', (_req, res) => {
  res.json({
    app_name:          process.env.APP_NAME          || 'NeoDoc',
    ai_enabled:        process.env.OPENAI_API_KEY    ? 'true' : 'false',
    registration_open: process.env.REGISTRATION_OPEN || 'true',
  });
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

