'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { requireAuth }  = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const PALETTE = ['#f59e0b','#3b82f6','#22c55e','#ef4444','#8b5cf6','#06b6d4','#ec4899','#f97316'];

function sanitise(s, max = 200) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, max).replace(/[<>]/g, '');
}

/* ── GET /api/correspondents ─────────────────────────── */
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.email, c.notes, c.color, c.created_at, c.updated_at,
           COUNT(d.id) AS doc_count
    FROM   correspondents c
    LEFT JOIN documents d ON d.correspondent_id = c.id AND d.user_id = ?
    WHERE  c.user_id = ?
    GROUP BY c.id
    ORDER BY c.name ASC
  `).all(req.user.id, req.user.id);
  res.json(rows);
});

/* ── POST /api/correspondents ────────────────────────── */
router.post('/', (req, res) => {
  const name  = sanitise(req.body.name || '', 100);
  if (!name) return res.status(400).json({ error: 'Name is required.' });

  const id        = uuidv4();
  const rawEmail  = sanitise(req.body.email || '', 200);
  const email     = rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : null;
  const notes     = sanitise(req.body.notes || '', 1000) || null;
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color
              : PALETTE[Math.floor(Math.random() * PALETTE.length)];

  try {
    db.prepare(
      `INSERT INTO correspondents (id, name, email, notes, color, user_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, name, email, notes, color, req.user.id);
    res.status(201).json({ id, name, email, notes, color, doc_count: 0 });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `Correspondent "${name}" already exists.` });
    }
    res.status(500).json({ error: 'Failed to create correspondent.' });
  }
});

/* ── PATCH /api/correspondents/:id ───────────────────── */
router.patch('/:id', (req, res) => {
  const c = db.prepare('SELECT id FROM correspondents WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'Correspondent not found.' });

  const fields = {};
  if (typeof req.body.name  === 'string') fields.name  = sanitise(req.body.name,  100) || undefined;
  if (typeof req.body.email === 'string') {
    const e = sanitise(req.body.email, 200);
    fields.email = (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) ? e : null;
  }
  if (typeof req.body.notes === 'string') fields.notes = sanitise(req.body.notes, 1000) || null;
  if (/^#[0-9a-f]{6}$/i.test(req.body.color)) fields.color = req.body.color;

  if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to update.' });

  const sets  = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const vals  = Object.values(fields);
  db.prepare(
    `UPDATE correspondents SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?`
  ).run(...vals, req.params.id, req.user.id);

  res.json({ message: 'Updated.' });
});

/* ── DELETE /api/correspondents/:id ──────────────────── */
router.delete('/:id', (req, res) => {
  const c = db.prepare('SELECT id FROM correspondents WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'Correspondent not found.' });

  db.prepare(`UPDATE documents SET correspondent_id = NULL WHERE correspondent_id = ? AND user_id = ?`).run(req.params.id, req.user.id);
  db.prepare('DELETE FROM correspondents WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ message: 'Deleted.' });
});

module.exports = router;
