'use strict';

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const db       = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function sanitise(str, max = 100) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max).replace(/[<>]/g, '');
}
function validHex(c) { return /^#[0-9A-Fa-f]{6}$/.test(c); }

/* ════════════════════════════════════════════════════════
   TAGS
════════════════════════════════════════════════════════ */
/* GET /api/tags */
router.get('/', (req, res) => {
  const tags = db.prepare(`
    SELECT t.id, t.name, t.color, t.created_at,
           COUNT(dt.document_id) as document_count
    FROM tags t
    LEFT JOIN document_tags dt ON t.id = dt.tag_id
    WHERE t.user_id = ?
    GROUP BY t.id ORDER BY t.name
  `).all(req.user.id);
  res.json(tags);
});

/* POST /api/tags */
router.post('/', (req, res) => {
  const name  = sanitise(req.body.name, 60);
  const color = validHex(req.body.color) ? req.body.color : '#22c55e';
  if (!name) return res.status(400).json({ error: 'Tag name is required.' });
  const existing = db.prepare('SELECT id FROM tags WHERE name = ? AND user_id = ?').get(name, req.user.id);
  if (existing) return res.status(409).json({ error: 'Tag name already exists.' });
  const id = uuidv4();
  db.prepare('INSERT INTO tags (id, name, color, user_id) VALUES (?, ?, ?, ?)').run(id, name, color, req.user.id);
  res.status(201).json({ id, name, color, document_count: 0 });
});

/* PATCH /api/tags/:id */
router.patch('/:id', (req, res) => {
  const tag = db.prepare('SELECT id FROM tags WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!tag) return res.status(404).json({ error: 'Tag not found.' });
  const name  = req.body.name  ? sanitise(req.body.name,  60) : undefined;
  const color = req.body.color && validHex(req.body.color) ? req.body.color : undefined;
  if (!name && !color) return res.status(400).json({ error: 'Nothing to update.' });
  if (name)  db.prepare('UPDATE tags SET name  = ? WHERE id = ? AND user_id = ?').run(name,  req.params.id, req.user.id);
  if (color) db.prepare('UPDATE tags SET color = ? WHERE id = ? AND user_id = ?').run(color, req.params.id, req.user.id);
  res.json({ message: 'Tag updated.' });
});

/* DELETE /api/tags/:id */
router.delete('/:id', (req, res) => {
  const tag = db.prepare('SELECT id FROM tags WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!tag) return res.status(404).json({ error: 'Tag not found.' });
  db.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ message: 'Tag deleted.' });
});

/* ════════════════════════════════════════════════════════
   DOCUMENT TYPES  (under /api/types)
════════════════════════════════════════════════════════ */
const typeRouter = express.Router();
typeRouter.use(requireAuth);

/* GET /api/types */
typeRouter.get('/', (req, res) => {
  const types = db.prepare(`
    SELECT dt.id, dt.name, dt.color, dt.created_at,
           COUNT(d.id) as document_count
    FROM document_types dt
    LEFT JOIN documents d ON d.type_id = dt.id AND d.user_id = ?
    WHERE dt.user_id = ?
    GROUP BY dt.id ORDER BY dt.name
  `).all(req.user.id, req.user.id);
  res.json(types);
});

/* POST /api/types */
typeRouter.post('/', (req, res) => {
  const name  = sanitise(req.body.name, 60);
  const color = validHex(req.body.color) ? req.body.color : '#6366f1';
  if (!name) return res.status(400).json({ error: 'Type name is required.' });
  const existing = db.prepare('SELECT id FROM document_types WHERE name = ? AND user_id = ?').get(name, req.user.id);
  if (existing) return res.status(409).json({ error: 'Type name already exists.' });
  const id = uuidv4();
  db.prepare('INSERT INTO document_types (id, name, color, user_id) VALUES (?, ?, ?, ?)').run(id, name, color, req.user.id);
  res.status(201).json({ id, name, color, document_count: 0 });
});

/* PATCH /api/types/:id */
typeRouter.patch('/:id', (req, res) => {
  const type = db.prepare('SELECT id FROM document_types WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!type) return res.status(404).json({ error: 'Type not found.' });
  const name  = req.body.name  ? sanitise(req.body.name,  60) : undefined;
  const color = req.body.color && validHex(req.body.color) ? req.body.color : undefined;
  if (!name && !color) return res.status(400).json({ error: 'Nothing to update.' });
  if (name)  db.prepare('UPDATE document_types SET name  = ? WHERE id = ? AND user_id = ?').run(name,  req.params.id, req.user.id);
  if (color) db.prepare('UPDATE document_types SET color = ? WHERE id = ? AND user_id = ?').run(color, req.params.id, req.user.id);
  res.json({ message: 'Type updated.' });
});

/* DELETE /api/types/:id */
typeRouter.delete('/:id', (req, res) => {
  const type = db.prepare('SELECT id FROM document_types WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!type) return res.status(404).json({ error: 'Type not found.' });
  db.prepare('DELETE FROM document_types WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ message: 'Type deleted.' });
});

module.exports = { tagRouter: router, typeRouter };
