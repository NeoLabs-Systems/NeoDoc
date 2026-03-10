'use strict';

const express  = require('express');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const pdfParse = require('pdf-parse');
const sharp    = require('sharp');
const { PDFDocument, degrees: pdfDeg } = require('pdf-lib');
const db       = require('../database');
const { requireAuth } = require('../middleware/auth');
const { autoProcess } = require('../services/ai');

const router = express.Router();
router.use(requireAuth);

/* ── Multer — in-memory only, nothing touches disk ──── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: parseInt(process.env.MAX_FILE_MB || getSetting('max_file_mb') || '50') * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const types  = process.env.ALLOWED_TYPES || getSetting('allowed_types') || '';
    const allowed = types.split(',').map(s => s.trim()).filter(Boolean);
    if (!allowed.length || allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`File type "${file.mimetype}" is not allowed.`));
  }
});

/* ── Helpers ─────────────────────────────────────────── */
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function hasAiKey() {
  const apiKey = process.env.OPENAI_API_KEY || getSetting('openai_api_key');
  return !!(apiKey && apiKey !== '••••••••');
}
function sanitise(str, max = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max).replace(/[<>]/g, '');
}
function audit(userId, action, targetId, details, ip) {
  try {
    db.prepare(
      'INSERT INTO audit_log (user_id, action, target_id, details, ip) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, action, targetId, details ? JSON.stringify(details) : null, ip || null);
  } catch (_) {}
}

/* ── POST /api/documents — Upload ────────────────────── */
router.post('/', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      // Multer errors (file type, size limit, etc.) → 400 instead of 500
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });

    const id    = uuidv4();
    const title = sanitise(req.body.title || req.file.originalname, 255) || req.file.originalname;
    const notes = sanitise(req.body.notes || '', 2000);
    const source = 'upload'; // always fixed — never trust client-supplied source

    // Verify foreign-key references belong to the uploading user
    const rawTypeId  = sanitise(req.body.type_id, 36) || null;
    const rawCorrId  = sanitise(req.body.correspondent_id, 36) || null;
    const typeId     = rawTypeId  && db.prepare('SELECT id FROM document_types  WHERE id = ? AND user_id = ?').get(rawTypeId,  req.user.id) ? rawTypeId  : null;
    const correspondentId = rawCorrId && db.prepare('SELECT id FROM correspondents WHERE id = ? AND user_id = ?').get(rawCorrId, req.user.id) ? rawCorrId : null;

    // Only keep tags that belong to this user
    let rawTagIds = [];
    if (req.body.tags) {
      try { rawTagIds = JSON.parse(req.body.tags); }
      catch (_) { return res.status(400).json({ error: 'Invalid tags format.' }); }
    }
    if (!Array.isArray(rawTagIds)) return res.status(400).json({ error: 'Tags must be an array.' });
    const safeTagIds = (() => {
      const valid = rawTagIds.filter(t => typeof t === 'string' && /^[0-9a-f-]{36}$/i.test(t));
      if (!valid.length) return [];
      const ph = valid.map(() => '?').join(',');
      return db.prepare(`SELECT id FROM tags WHERE id IN (${ph}) AND user_id = ?`).all(...valid, req.user.id).map(r => r.id);
    })();

    // ── Auto-orient images based on EXIF rotation (scanner / camera) ───────
    let fileBuffer = req.file.buffer;
    let fileSize   = req.file.size;
    if (req.file.mimetype.startsWith('image/')) {
      try {
        fileBuffer = await sharp(fileBuffer).rotate().toBuffer();
        fileSize   = fileBuffer.length;
      } catch (_) { /* non-fatal — keep original */ }
    }

    // Extract text for search + AI
    let textContent = null;
    if (req.file.mimetype === 'application/pdf') {
      try {
        const parsed = await pdfParse(req.file.buffer);
        textContent  = parsed.text ? parsed.text.slice(0, 100000) : null;
      } catch (_) { /* non-fatal */ }
    } else if (req.file.mimetype.startsWith('text/')) {
      try {
        textContent = req.file.buffer.toString('utf8').slice(0, 100000);
      } catch (_) {}
    }

    db.prepare(`
      INSERT INTO documents (id, title, filename, mime_type, file_size, content, text_content, notes, type_id, correspondent_id, user_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, req.file.originalname, req.file.mimetype, fileSize, fileBuffer, textContent, notes, typeId, correspondentId, req.user.id, source);

    // Attach tags
    if (safeTagIds.length) {
      const ins = db.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)');
      const tx  = db.transaction((ids) => { for (const t of ids) ins.run(id, t); });
      tx(safeTagIds);
    }

    audit(req.user.id, 'upload', id, { title, filename: req.file.originalname }, req.ip);

    // AI auto-processing (non-blocking)
    if (hasAiKey()) {
      autoProcess(id, textContent, req.user.id).catch(() => {});
    }

    res.status(201).json({ id, title, message: 'Document uploaded successfully.' });
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: `File exceeds maximum allowed size of ${getSetting('max_file_mb')} MB.` });
    console.error('[upload]', err.message);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

/* ── GET /api/documents — List with search/filter ───── */
router.get('/', (req, res) => {
  const { q, tag, type, page = 1, limit = 24, sort = 'created_at', order = 'desc' } = req.query;
  const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
  const lim    = Math.min(100, parseInt(limit));
  const validSort  = ['created_at','updated_at','title','file_size'].includes(sort) ? sort : 'created_at';
  const validOrder = order === 'asc' ? 'ASC' : 'DESC';
  const UUID_RE    = /^[0-9a-f-]{36}$/i;

  let whereClauses = ['d.user_id = ?'];
  let params = [req.user.id];

  if (q) {
    // Strip FTS5 operators/special chars so the query is safe literal prefix search.
    // Splits into individual terms, each double-quoted and suffixed with * for prefix match.
    const ftsTerms = q
      .replace(/["'*()@^]/g, ' ')                  // remove FTS5 special chars
      .replace(/\b(OR|AND|NOT|NEAR)\b/gi, ' ')     // remove FTS5 boolean operators
      .trim().slice(0, 200)
      .split(/\s+/).filter(Boolean).slice(0, 15);   // at most 15 tokens
    if (ftsTerms.length) {
      whereClauses.push(`d.id IN (
        SELECT documents.id FROM documents
        INNER JOIN documents_fts ON documents.rowid = documents_fts.rowid
        WHERE documents_fts MATCH ?
      )`);
      // Each term wrapped in doubled-quotes (FTS5 phrase), followed by * for prefix
      params.push(ftsTerms.map(t => `"${t.replace(/"/g, '""')}"*`).join(' '));
    }
  }
  if (tag && UUID_RE.test(tag)) {
    whereClauses.push(`d.id IN (SELECT document_id FROM document_tags WHERE tag_id = ?)`);
    params.push(tag);
  }
  if (type && UUID_RE.test(type)) {
    whereClauses.push(`d.type_id = ?`);
    params.push(type);
  }
  if (req.query.correspondent && UUID_RE.test(req.query.correspondent)) {
    whereClauses.push(`d.correspondent_id = ?`);
    params.push(req.query.correspondent);
  }

  const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  try {
  const rows = db.prepare(`
    SELECT d.id, d.title, d.filename, d.mime_type, d.file_size, d.notes,
           d.type_id, d.correspondent_id, d.created_at, d.updated_at, d.source,
           dt.name as type_name, dt.color as type_color,
           c.name as correspondent_name, c.color as correspondent_color,
           GROUP_CONCAT(t.id || '|' || t.name || '|' || t.color, ';;') as tags_raw
    FROM documents d
    LEFT JOIN document_types dt ON d.type_id = dt.id
    LEFT JOIN correspondents c ON d.correspondent_id = c.id
    LEFT JOIN document_tags dta ON d.id = dta.document_id
    LEFT JOIN tags t ON dta.tag_id = t.id
    ${where}
    GROUP BY d.id
    ORDER BY d.${validSort} ${validOrder}
    LIMIT ? OFFSET ?
  `).all(...params, lim, offset);

  const total = db.prepare(`
    SELECT COUNT(DISTINCT d.id) as n FROM documents d ${where}
  `).get(...params).n;

  const documents = rows.map(({ tags_raw, user_id, ...r }) => ({
    ...r,
    tags: tags_raw
      ? tags_raw.split(';;').map(s => {
          const [tid, tname, tcolor] = s.split('|');
          return { id: tid, name: tname, color: tcolor };
        })
      : []
  }));

  res.json({ documents, total, page: parseInt(page), limit: lim });
  } catch (err) {
    // FTS5 or other query error — return empty results rather than 500
    console.error('[documents/search]', err.message);
    res.json({ documents: [], total: 0, page: parseInt(page), limit: lim });
  }
});

/* ── GET /api/documents/:id — Meta + text ────────────── */
router.get('/:id', (req, res) => {
  const doc = db.prepare(`
    SELECT d.id, d.title, d.filename, d.mime_type, d.file_size, d.notes, d.text_content,
           d.type_id, d.correspondent_id, d.created_at, d.updated_at, d.source,
           dt.name as type_name, dt.color as type_color,
           c.name as correspondent_name, c.color as correspondent_color
    FROM documents d
    LEFT JOIN document_types dt ON d.type_id = dt.id
    LEFT JOIN correspondents c ON d.correspondent_id = c.id
    WHERE d.id = ? AND d.user_id = ?
  `).get(req.params.id, req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const tags = db.prepare(`
    SELECT t.id, t.name, t.color FROM tags t
    INNER JOIN document_tags dt ON t.id = dt.tag_id
    WHERE dt.document_id = ? AND t.user_id = ?
  `).all(req.params.id, req.user.id);

  res.json({ ...doc, tags });
});

/* ── GET /api/documents/:id/file — Download raw file ── */
router.get('/:id/file', (req, res) => {
  const doc = db.prepare('SELECT filename, mime_type, content FROM documents WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  audit(req.user.id, 'download', req.params.id, null, req.ip);
  res.set('Content-Type', doc.mime_type);
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.filename)}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-store, private');
  res.send(doc.content);
});

/* ── GET /api/documents/:id/view — Inline view ───────── */
router.get('/:id/view', (req, res, next) => {
  // Allow JWT via ?token= for <img src> and <iframe src> embedding (read-only endpoint only)
  if (req.query.token && !req.headers['authorization']) {
    req.headers['authorization'] = `Bearer ${req.query.token}`;
  }
  next();
}, requireAuth, (req, res) => {
  const doc = db.prepare('SELECT filename, mime_type, content FROM documents WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  res.set('Content-Type', doc.mime_type);
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(doc.filename)}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-store, private');
  res.send(doc.content);
});

/* ── PATCH /api/documents/:id — Update metadata ─────── */
router.patch('/:id', (req, res) => {
  const doc = db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const updates = {};
  if (typeof req.body.title === 'string') updates.title = sanitise(req.body.title, 255);
  if (typeof req.body.notes === 'string') updates.notes = sanitise(req.body.notes, 2000);
  if (req.body.type_id !== undefined) {
    const tid = req.body.type_id ? sanitise(req.body.type_id, 36) : null;
    updates.type_id = tid && db.prepare('SELECT id FROM document_types WHERE id = ? AND user_id = ?').get(tid, req.user.id) ? tid : null;
  }
  if (req.body.correspondent_id !== undefined) {
    const cid = req.body.correspondent_id ? sanitise(req.body.correspondent_id, 36) : null;
    updates.correspondent_id = cid && db.prepare('SELECT id FROM correspondents WHERE id = ? AND user_id = ?').get(cid, req.user.id) ? cid : null;
  }

  if (Object.keys(updates).length) {
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(
      `UPDATE documents SET ${setClauses}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?`
    ).run(...Object.values(updates), req.params.id, req.user.id);
  }

  // Replace tags if provided — verify ownership before attaching
  if (Array.isArray(req.body.tags)) {
    db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(req.params.id);
    const rawIds = req.body.tags.filter(t => typeof t === 'string' && /^[0-9a-f-]{36}$/i.test(t));
    if (rawIds.length) {
      const ph = rawIds.map(() => '?').join(',');
      const safeIds = db.prepare(`SELECT id FROM tags WHERE id IN (${ph}) AND user_id = ?`).all(...rawIds, req.user.id).map(r => r.id);
      const ins = db.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)');
      const tx  = db.transaction((ids) => { for (const t of ids) ins.run(req.params.id, t); });
      tx(safeIds);
    }
  }

  audit(req.user.id, 'update', req.params.id, updates, req.ip);
  res.json({ message: 'Document updated.' });
});

/* ── POST /api/documents/:id/rotate — rotate image or all PDF pages ─────── */
router.post('/:id/rotate', async (req, res) => {
  const rawAngle = parseInt(req.body.angle);
  if (![90, 180, 270, -90].includes(rawAngle))
    return res.status(400).json({ error: 'angle must be 90, 180, 270, or -90.' });

  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const SUPPORTED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!SUPPORTED.includes(doc.mime_type))
    return res.status(400).json({ error: 'Rotation is only supported for images and PDFs.' });

  // Normalise to 0-359
  const degrees = ((rawAngle % 360) + 360) % 360;

  try {
    let newContent, newTextContent = doc.text_content;

    if (doc.mime_type.startsWith('image/')) {
      newContent = await sharp(doc.content).rotate(degrees).toBuffer();
    } else {
      // PDF — rotate every page
      const pdfDoc = await PDFDocument.load(doc.content);
      for (const page of pdfDoc.getPages()) {
        const current = page.getRotation().angle;
        page.setRotation(pdfDeg((current + degrees) % 360));
      }
      newContent = Buffer.from(await pdfDoc.save());
      // Re-extract text so FTS + AI have accurate content
      try {
        const parsed = await pdfParse(newContent);
        newTextContent = parsed.text ? parsed.text.slice(0, 100000) : doc.text_content;
      } catch (_) {}
    }

    db.prepare(
      `UPDATE documents
       SET content = ?, text_content = ?, file_size = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND user_id = ?`
    ).run(newContent, newTextContent, newContent.length, req.params.id, req.user.id);

    audit(req.user.id, 'rotate', req.params.id, { angle: degrees }, req.ip);

    // Re-run AI whenever we have text content (non-blocking)
    let reprocessed = false;
    if (hasAiKey() && newTextContent && newTextContent.trim().length >= 20) {
      autoProcess(req.params.id, newTextContent, req.user.id).catch(() => {});
      reprocessed = true;
    }

    res.json({ ok: true, reprocessed, angle: degrees });
  } catch (e) {
    console.error('[rotate]', e.message);
    res.status(500).json({ error: 'Rotation failed.' });
  }
});

/* ── DELETE /api/documents/:id ───────────────────────── */
router.delete('/:id', (req, res) => {
  const doc = db.prepare('SELECT id, title FROM documents WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  audit(req.user.id, 'delete', req.params.id, { title: doc.title }, req.ip);
  res.json({ message: 'Document deleted.' });
});

/* ── DELETE /api/documents  (bulk) ── body: { ids: [uuid, …] } */
router.delete('/', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(i => typeof i === 'string').slice(0, 200) : [];
  if (!ids.length) return res.status(400).json({ error: 'No document IDs provided.' });
  const del = db.transaction(() => {
    let count = 0;
    for (const id of ids) {
      const doc = db.prepare('SELECT id, title FROM documents WHERE id = ? AND user_id = ?').get(id, req.user.id);
      if (!doc) continue;
      db.prepare('DELETE FROM documents WHERE id = ?').run(id);
      audit(req.user.id, 'bulk_delete', id, { title: doc.title }, req.ip);
      count++;
    }
    return count;
  });
  const deleted = del();
  res.json({ message: `${deleted} document(s) deleted.`, deleted });
});

module.exports = router;
