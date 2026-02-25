'use strict';

const crypto   = require('crypto');
const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const db       = require('../database');
const { requireAuth } = require('../middleware/auth');
const { sendSigningInvite, sendSigningReminder, sendCompletionNotice, sendSignedCopy, testSmtp } = require('../services/email');

const router = express.Router();

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function sanitise(str, max = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max).replace(/[<>]/g, '');
}
function getEnvelope(id, userId) {
  return db.prepare('SELECT * FROM sign_envelopes WHERE id = ? AND user_id = ?').get(id, userId);
}
function getEnvelopePublic(id) {
  return db.prepare('SELECT * FROM sign_envelopes WHERE id = ?').get(id);
}
function sigEvent(envelopeId, signerId, action, ip, ua, details) {
  try {
    db.prepare(
      `INSERT INTO sign_events (envelope_id, signer_id, action, ip, user_agent, details)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(envelopeId, signerId || null, action, ip || null, ua || null,
      details ? JSON.stringify(details) : null);
  } catch (_) {}
}
function hexToColour(hex) {
  const c = hex.replace('#', '');
  return rgb(
    parseInt(c.substring(0,2),16)/255,
    parseInt(c.substring(2,4),16)/255,
    parseInt(c.substring(4,6),16)/255
  );
}

/* ── Signer colours pool ────────────────────────────────────────────────── */
const SIGNER_COLOURS = [
  '#6366f1','#ec4899','#f59e0b','#22c55e','#06b6d4','#8b5cf6',
];

/* ══════════════════════════════════════════════════════════════════════════
   AUTH-REQUIRED SENDER ENDPOINTS
   ══════════════════════════════════════════════════════════════════════════ */
router.use('/envelopes', requireAuth);

/* ── GET /api/signing/envelopes — list ──────────────────────────────────── */
router.get('/envelopes', (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, d.title as doc_title,
           (SELECT COUNT(*) FROM sign_signers WHERE envelope_id = e.id) as signer_count,
           (SELECT COUNT(*) FROM sign_signers WHERE envelope_id = e.id AND status = 'signed') as signed_count
    FROM sign_envelopes e
    LEFT JOIN documents d ON d.id = e.document_id
    WHERE e.user_id = ?
    ORDER BY e.created_at DESC
  `).all(req.user.id);
  res.json(rows);
});

/* ── POST /api/signing/envelopes — create ───────────────────────────────── */
router.post('/envelopes', (req, res) => {
  const { document_id, title, message, signers, from_email, send_copy, email_subject } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });

  // Validate document belongs to user
  if (document_id) {
    const doc = db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?').get(document_id, req.user.id);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
  }

  // Validate signers array
  if (!Array.isArray(signers) || signers.length === 0)
    return res.status(400).json({ error: 'At least one signer is required.' });
  for (const s of signers) {
    if (!s.name || !s.name.trim()) return res.status(400).json({ error: 'Every signer must have a name.' });
    if (!s.email || !s.email.trim()) return res.status(400).json({ error: 'Every signer must have an email.' });
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO sign_envelopes (id, user_id, document_id, title, message, from_email, send_copy, email_subject)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.id, document_id || null, sanitise(title, 255), sanitise(message || '', 2000),
    sanitise(from_email || '', 200), send_copy ? 1 : 0, sanitise(email_subject || '', 500));

  // Insert signers
  const insertSigner = db.prepare(
    `INSERT INTO sign_signers (id, envelope_id, name, email, order_idx, token, color)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const signersOut = [];
  signers.forEach((s, i) => {
    const sid = uuidv4();
    const token = `${uuidv4().replace(/-/g,'')}${uuidv4().replace(/-/g,'')}`;
    const color = SIGNER_COLOURS[i % SIGNER_COLOURS.length];
    insertSigner.run(sid, id, sanitise(s.name, 100), sanitise(s.email, 200), i, token, color);
    signersOut.push({ id: sid, name: s.name, email: s.email, order_idx: i, token, color });
  });

  sigEvent(id, null, 'created', req.ip, req.headers['user-agent']);
  res.status(201).json({ id, signers: signersOut });
});

/* ── GET /api/signing/envelopes/:id — detail ────────────────────────────── */
router.get('/envelopes/:id', (req, res) => {
  const env = getEnvelope(req.params.id, req.user.id);
  if (!env) return res.status(404).json({ error: 'Envelope not found.' });

  const signers = db.prepare('SELECT * FROM sign_signers WHERE envelope_id = ? ORDER BY order_idx').all(env.id);
  const fields  = db.prepare('SELECT * FROM sign_fields  WHERE envelope_id = ? ORDER BY page, y, x').all(env.id);
  const events  = db.prepare('SELECT * FROM sign_events  WHERE envelope_id = ? ORDER BY created_at').all(env.id);

  // Strip signed_document blob from the response
  const { signed_document: _sd, ...envClean } = env;
  res.json({ ...envClean, has_signed_document: !!env.signed_document, signers, fields, events });
});

/* ── PUT /api/signing/envelopes/:id — save fields / title / message ─────── */
router.put('/envelopes/:id', (req, res) => {
  const env = getEnvelope(req.params.id, req.user.id);
  if (!env) return res.status(404).json({ error: 'Envelope not found.' });
  if (env.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft envelopes.' });

  const { title, message, fields } = req.body;
  if (title) {
    db.prepare(`UPDATE sign_envelopes SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(sanitise(title, 255), env.id);
  }
  if (typeof message === 'string') {
    db.prepare(`UPDATE sign_envelopes SET message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(sanitise(message, 2000), env.id);
  }

  if (Array.isArray(fields)) {
    // Replace all fields for this envelope atomically
    const replace = db.transaction(() => {
      db.prepare('DELETE FROM sign_fields WHERE envelope_id = ?').run(env.id);
      const ins = db.prepare(
        `INSERT INTO sign_fields (id, envelope_id, signer_id, type, page, x, y, w, h, label, required)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const f of fields) {
        // Validate signer belongs to this envelope
        const signer = db.prepare('SELECT id FROM sign_signers WHERE id = ? AND envelope_id = ?')
          .get(f.signer_id, env.id);
        if (!signer) continue;
        const TYPES = ['signature','initials','text','date','checkbox'];
        if (!TYPES.includes(f.type)) continue;
        ins.run(
          uuidv4(), env.id, signer.id,
          f.type,
          Math.max(1, parseInt(f.page) || 1),
          parseFloat(f.x) || 0,
          parseFloat(f.y) || 0,
          Math.max(2, parseFloat(f.w) || 18),
          Math.max(2, parseFloat(f.h) || 5),
          sanitise(f.label || '', 100),
          f.required !== false ? 1 : 0
        );
      }
    });
    replace();
  }

  res.json({ ok: true });
});

/* ── POST /api/signing/envelopes/:id/send — activate for signing ─────────── */
router.post('/envelopes/:id/send', (req, res) => {
  const env = getEnvelope(req.params.id, req.user.id);
  if (!env) return res.status(404).json({ error: 'Envelope not found.' });
  if (env.status !== 'draft') return res.status(400).json({ error: 'Envelope is not in draft status.' });

  const fieldCount = db.prepare('SELECT COUNT(*) as c FROM sign_fields WHERE envelope_id = ?').get(env.id).c;
  if (fieldCount === 0) return res.status(400).json({ error: 'Add at least one signing field before sending.' });

  db.prepare(`UPDATE sign_envelopes SET status = 'out_for_signature', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
    .run(env.id);

  sigEvent(env.id, null, 'sent', req.ip, req.headers['user-agent']);

  const signers = db.prepare('SELECT id, name, email, token FROM sign_signers WHERE envelope_id = ? ORDER BY order_idx').all(env.id);

  // Fire invitation emails (best-effort, non-blocking)
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  for (const s of signers) {
    sendSigningInvite({
      userId: req.user.id,
      envTitle: env.title,
      envMessage: env.message,
      emailSubject: env.email_subject || '',
      signerName: s.name,
      signerEmail: s.email,
      signingUrl: `${baseUrl}/sign?token=${s.token}`,
    }).catch(e => console.warn('[signing] invite email failed:', e.message));
  }

  res.json({ ok: true, signers, baseUrl });
});

/* ── POST /api/signing/envelopes/:id/remind — send reminders ───────────── */
router.post('/envelopes/:id/remind', async (req, res) => {
  const env = getEnvelope(req.params.id, req.user.id);
  if (!env) return res.status(404).json({ error: 'Envelope not found.' });
  if (env.status !== 'out_for_signature') return res.status(400).json({ error: 'Can only send reminders for envelopes that are out for signature.' });

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const pending = db.prepare(`SELECT id, name, email, token FROM sign_signers WHERE envelope_id = ? AND status != 'signed'`).all(env.id);
  if (pending.length === 0) return res.status(400).json({ error: 'All signers have already signed.' });

  const results = [];
  for (const s of pending) {
    try {
      const r = await sendSigningReminder({
        userId: req.user.id,
        envTitle: env.title,
        signerName: s.name,
        signerEmail: s.email,
        signingUrl: `${baseUrl}/sign?token=${s.token}`,
      });
      results.push({ name: s.name, email: s.email, ...r });
      sigEvent(env.id, s.id, 'reminded', req.ip, req.headers['user-agent']);
    } catch (e) {
      results.push({ name: s.name, email: s.email, error: e.message });
    }
  }

  res.json({ ok: true, results });
});

/* ── POST /api/signing/envelopes/:id/void — void envelope ───────────────── */
router.post('/envelopes/:id/void', (req, res) => {
  const env = getEnvelope(req.params.id, req.user.id);
  if (!env) return res.status(404).json({ error: 'Envelope not found.' });
  if (env.status === 'voided') return res.status(400).json({ error: 'Already voided.' });

  db.prepare(`UPDATE sign_envelopes SET status = 'voided', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
    .run(env.id);
  sigEvent(env.id, null, 'voided', req.ip, req.headers['user-agent']);
  res.json({ ok: true });
});

/* ── DELETE /api/signing/envelopes/:id — delete draft ───────────────────── */
router.delete('/envelopes/:id', (req, res) => {
  const env = getEnvelope(req.params.id, req.user.id);
  if (!env) return res.status(404).json({ error: 'Envelope not found.' });
  if (!['draft','voided','completed'].includes(env.status))
    return res.status(400).json({ error: 'Only draft, completed, or voided envelopes can be deleted.' });

  db.prepare('DELETE FROM sign_envelopes WHERE id = ?').run(env.id);
  res.json({ ok: true });
});

/* ── POST /api/signing/envelopes/:id/import — add signed PDF to document library ── */
router.post('/envelopes/:id/import', async (req, res) => {
  const env = getEnvelope(req.params.id, req.user.id);
  if (!env) return res.status(404).json({ error: 'Envelope not found.' });
  if (env.status !== 'completed') return res.status(400).json({ error: 'Only completed envelopes can be imported.' });
  if (!env.signed_document) return res.status(404).json({ error: 'No signed document available.' });

  const newId = uuidv4();
  const filename = `${env.title.replace(/[^a-z0-9]/gi,'_')}_signed.pdf`;
  db.prepare(
    `INSERT INTO documents (id, user_id, title, filename, mime_type, file_size, content, source)
     VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, 'upload')`
  ).run(newId, req.user.id, `${env.title} (Signed)`, filename,
    Buffer.isBuffer(env.signed_document) ? env.signed_document.length : env.signed_document.byteLength,
    env.signed_document);

  res.json({ ok: true, document_id: newId, title: `${env.title} (Signed)` });
});

/* ── GET /api/signing/envelopes/:id/document — serve original PDF ─────────── */
router.get('/envelopes/:id/document', (req, res) => {
  const env = getEnvelope(req.params.id, req.user.id);
  if (!env) return res.status(404).json({ error: 'Envelope not found.' });
  if (!env.document_id) return res.status(404).json({ error: 'No document attached.' });

  const doc = db.prepare('SELECT content, mime_type, filename FROM documents WHERE id = ?').get(env.document_id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  res.set('Content-Type', doc.mime_type);
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(doc.filename)}"`);
  res.send(doc.content);
});

/* ── GET /api/signing/envelopes/:id/download — download signed PDF ─────── */
router.get('/envelopes/:id/download', (req, res) => {
  const env = getEnvelope(req.params.id, req.user.id);
  if (!env) return res.status(404).json({ error: 'Envelope not found.' });
  if (!env.signed_document) return res.status(404).json({ error: 'Signed document not yet available.' });

  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(env.title)}-signed.pdf"`);
  sigEvent(env.id, null, 'downloaded', req.ip, req.headers['user-agent']);
  res.send(env.signed_document);
});

/* ══════════════════════════════════════════════════════════════════════════
   PUBLIC TOKEN-BASED SIGNER ENDPOINTS (no JWT auth)
   ══════════════════════════════════════════════════════════════════════════ */

/* ── GET /api/signing/public/:token — get signing info ──────────────────── */
router.get('/public/:token', (req, res) => {
  const signer = db.prepare('SELECT * FROM sign_signers WHERE token = ?').get(req.params.token);
  if (!signer) return res.status(404).json({ error: 'Invalid or expired signing link.' });

  const env = getEnvelopePublic(signer.envelope_id);
  if (!env) return res.status(404).json({ error: 'Envelope not found.' });
  if (env.status === 'voided') return res.status(410).json({ error: 'This signing request has been voided.' });
  if (env.status === 'draft') return res.status(403).json({ error: 'This document is not yet ready for signing.' });

  if (signer.status === 'pending') {
    db.prepare(`UPDATE sign_signers SET status = 'viewed' WHERE id = ?`).run(signer.id);
    sigEvent(env.id, signer.id, 'viewed', req.ip, req.headers['user-agent']);
  }

  // Intentionally exclude email — signers should not see each other's email addresses
  const allSigners = db.prepare('SELECT id, name, color, status, order_idx FROM sign_signers WHERE envelope_id = ? ORDER BY order_idx').all(env.id);
  const myFields   = db.prepare('SELECT * FROM sign_fields WHERE signer_id = ? ORDER BY page, y, x').all(signer.id);
  const alreadySigned = signer.status === 'signed';

  res.json({
    envelope: {
      id: env.id,
      title: env.title,
      message: env.message,
      status: env.status,
    },
    signer: { id: signer.id, name: signer.name, email: signer.email, color: signer.color, status: signer.status },
    allSigners,
    fields: myFields,
    alreadySigned,
  });
});

/* ── GET /api/signing/public/:token/document — serve PDF for signer ─────── */
router.get('/public/:token/document', (req, res) => {
  const signer = db.prepare('SELECT * FROM sign_signers WHERE token = ?').get(req.params.token);
  if (!signer) return res.status(404).json({ error: 'Invalid signing link.' });

  const env = getEnvelopePublic(signer.envelope_id);
  if (!env) return res.status(404).json({ error: 'Envelope not found.' });
  // Check status before attempting to serve the document
  if (env.status === 'voided') return res.status(410).json({ error: 'This signing request has been voided.' });
  if (env.status === 'draft')  return res.status(403).json({ error: 'This document is not yet ready for signing.' });
  if (!env.document_id) return res.status(404).json({ error: 'Document not found.' });

  const doc = db.prepare('SELECT content, mime_type, filename FROM documents WHERE id = ?').get(env.document_id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  res.set('Content-Type', doc.mime_type);
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(doc.filename)}"`);
  res.send(doc.content);
});

/* ── POST /api/signing/public/:token/submit — submit completed signature ── */
router.post('/public/:token/submit', async (req, res) => {
  const signer = db.prepare('SELECT * FROM sign_signers WHERE token = ?').get(req.params.token);
  if (!signer) return res.status(404).json({ error: 'Invalid signing link.' });

  const env = getEnvelopePublic(signer.envelope_id);
  if (!env) return res.status(404).json({ error: 'Envelope not found.' });
  if (env.status !== 'out_for_signature') return res.status(400).json({ error: 'This document is not awaiting signatures.' });
  if (signer.status === 'signed') return res.status(400).json({ error: 'You have already signed this document.' });

  const { fieldValues } = req.body; // { [fieldId]: value }
  if (!fieldValues || typeof fieldValues !== 'object')
    return res.status(400).json({ error: 'fieldValues required.' });
  if (Object.keys(fieldValues).length > 200)
    return res.status(400).json({ error: 'Too many field values.' });

  // Validate required fields
  const myFields = db.prepare('SELECT * FROM sign_fields WHERE signer_id = ?').all(signer.id);
  for (const f of myFields) {
    if (f.required && !fieldValues[f.id])
      return res.status(400).json({ error: `Field "${f.type}" on page ${f.page} is required.` });
  }

  // Save field values
  const updateField = db.prepare('UPDATE sign_fields SET value = ? WHERE id = ? AND signer_id = ?');
  const saveFields = db.transaction(() => {
    for (const [fieldId, value] of Object.entries(fieldValues)) {
      const safeValue = typeof value === 'string' ? value.slice(0, 100000) : JSON.stringify(value);
      updateField.run(safeValue, fieldId, signer.id);
    }
  });
  saveFields();

  // Mark signer as signed
  db.prepare(
    `UPDATE sign_signers SET status = 'signed', signed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), ip = ?, user_agent = ? WHERE id = ?`
  ).run(req.ip || null, req.headers['user-agent'] || null, signer.id);
  sigEvent(env.id, signer.id, 'signed', req.ip, req.headers['user-agent']);

  // Check if all signers have signed → complete envelope + generate signed PDF
  const pending = db.prepare(`SELECT COUNT(*) as c FROM sign_signers WHERE envelope_id = ? AND status != 'signed'`).get(env.id).c;
  if (pending === 0) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    try {
      const signedPdf = await generateSignedPdf(env, baseUrl);
      const docHash = crypto.createHash('sha256').update(signedPdf).digest('hex');
      db.prepare(
        `UPDATE sign_envelopes SET status = 'completed', signed_document = ?, doc_hash = ?,
         completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).run(signedPdf, docHash, env.id);
      sigEvent(env.id, null, 'completed', null, null);
      // Notify owner (best-effort)
      const ownerRow = db.prepare('SELECT email, username FROM users WHERE id = ?').get(env.user_id);
      if (ownerRow) {
        sendCompletionNotice({
          userId: env.user_id,
          envTitle: env.title,
          ownerEmail: ownerRow.email,
          ownerName: ownerRow.username,
        }).catch(() => {});
      }
      // Send copy to signers if enabled
      const envFull = db.prepare('SELECT send_copy FROM sign_envelopes WHERE id = ?').get(env.id);
      if (envFull?.send_copy) {
        const allSigners = db.prepare('SELECT name, email FROM sign_signers WHERE envelope_id = ?').all(env.id);
        sendSignedCopy({
          userId: env.user_id,
          envTitle: env.title,
          signers: allSigners,
          pdfBuffer: Buffer.from(signedPdf),
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[signing] PDF generation error:', e.message);
      // Still mark as completed even if PDF generation fails
      db.prepare(
        `UPDATE sign_envelopes SET status = 'completed',
         completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).run(env.id);
    }
  }

  res.json({ ok: true, allSigned: pending === 0 });
});

/* ══════════════════════════════════════════════════════════════════════════
   PUBLIC VERIFICATION ENDPOINT (no auth)
   ══════════════════════════════════════════════════════════════════════════ */

/* ── GET /api/signing/verify/:id — public seal / integrity check ─────────── */
router.get('/verify/:id', (req, res) => {
  const env = db.prepare(
    `SELECT id, title, status, created_at, completed_at, doc_hash
     FROM sign_envelopes WHERE id = ?`
  ).get(req.params.id);
  if (!env) return res.status(404).json({ error: 'Envelope not found.' });

  // Only return name + status from signers — no emails, no IPs on public endpoint
  const signers = db.prepare(
    `SELECT name, status, signed_at FROM sign_signers WHERE envelope_id = ? ORDER BY order_idx`
  ).all(env.id);

  res.json({ ...env, signers });
});

/* ══════════════════════════════════════════════════════════════════════════
   SMTP SETTINGS (per-user, auth-required)
   ══════════════════════════════════════════════════════════════════════════ */
router.use('/smtp', requireAuth);

/* ── GET /api/signing/smtp — retrieve current user's SMTP settings ─────── */
router.get('/smtp', (req, res) => {
  const row = db.prepare(
    `SELECT smtp_host, smtp_port, smtp_user, smtp_from, smtp_secure, smtp_enabled FROM users WHERE id = ?`
  ).get(req.user.id);
  // Note: smtp_pass is intentionally never returned to the client
  res.json(row || {});
});

/* ── PUT /api/signing/smtp — save SMTP settings ─────────────────────────── */
router.put('/smtp', (req, res) => {
  const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, smtp_secure, smtp_enabled } = req.body;
  const SECURE_OPTS = ['tls', 'ssl', 'none'];
  if (smtp_secure && !SECURE_OPTS.includes(smtp_secure))
    return res.status(400).json({ error: 'smtp_secure must be tls, ssl, or none.' });

  // Only update pass if a non-empty value is provided (avoid wiping with empty string)
  const updates = [
    `smtp_host    = ?`, `smtp_port    = ?`, `smtp_user    = ?`,
    `smtp_from    = ?`, `smtp_secure  = ?`, `smtp_enabled = ?`,
  ];
  const vals = [
    sanitise(smtp_host    || '', 200),
    parseInt(smtp_port)   || 587,
    sanitise(smtp_user    || '', 200),
    sanitise(smtp_from    || '', 200),
    smtp_secure           || 'tls',
    smtp_enabled === true || smtp_enabled === 'true' ? 'true' : 'false',
  ];

  if (smtp_pass && smtp_pass.length > 0) {
    updates.push(`smtp_pass = ?`);
    vals.push(smtp_pass.slice(0, 500));
  }

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...vals, req.user.id);
  res.json({ ok: true });
});

/* ── POST /api/signing/smtp/test — verify SMTP connection ───────────────── */
router.post('/smtp/test', async (req, res) => {
  try {
    await testSmtp(req.user.id);
    res.json({ ok: true, message: 'Connection successful.' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ── PDF generation with pdf-lib ────────────────────────────────────────── */
async function generateSignedPdf(env, baseUrl = '') {
  const doc = db.prepare('SELECT content FROM documents WHERE id = ?').get(env.document_id);
  if (!doc) throw new Error('Original document not found');

  const pdfDoc = await PDFDocument.load(doc.content);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = pdfDoc.getPages();

  // Get all completed fields with signer info
  const fields = db.prepare(`
    SELECT f.*, s.name as signer_name, s.email as signer_email, s.color as signer_color
    FROM sign_fields f
    JOIN sign_signers s ON s.id = f.signer_id
    WHERE f.envelope_id = ? AND f.value IS NOT NULL
    ORDER BY f.page, f.y, f.x
  `).all(env.id);

  for (const field of fields) {
    const pageIdx = field.page - 1;
    if (pageIdx < 0 || pageIdx >= pages.length) continue;
    const page = pages[pageIdx];
    const { width: pw, height: ph } = page.getSize();

    // Convert percentage coords to PDF points (PDF origin is bottom-left)
    const fx = (field.x / 100) * pw;
    const fy = ph - ((field.y / 100) * ph) - ((field.h / 100) * ph);
    const fw = (field.w / 100) * pw;
    const fh = (field.h / 100) * ph;

    try {
      if (field.type === 'signature' || field.type === 'initials') {
        // value is a data URL (PNG or JPEG canvas)
        let dataUrl = field.value;
        if (typeof dataUrl === 'string' && dataUrl.startsWith('{')) {
          try { dataUrl = JSON.parse(dataUrl).dataUrl; } catch (_) {}
        }
        if (dataUrl && dataUrl.startsWith('data:image/')) {
          const isJpeg = dataUrl.includes('jpeg') || dataUrl.includes('jpg');
          const b64 = dataUrl.split(',')[1];
          const imgBytes = Buffer.from(b64, 'base64');
          const img = isJpeg
            ? await pdfDoc.embedJpg(imgBytes)
            : await pdfDoc.embedPng(imgBytes);
          page.drawImage(img, { x: fx, y: fy, width: fw, height: fh });
        }
      } else if (field.type === 'date') {
        const val = field.value || new Date().toLocaleDateString();
        const fSize = Math.min(fh * 0.55, 11);
        page.drawRectangle({ x: fx, y: fy, width: fw, height: fh,
          borderColor: hexToColour('#6366f1'), borderWidth: 0.5,
          color: rgb(0.97, 0.97, 1), opacity: 0.6 });
        page.drawText(val, { x: fx + 3, y: fy + fh * 0.25, size: fSize,
          font: helvetica, color: rgb(0.1, 0.1, 0.4), maxWidth: fw - 6 });
      } else if (field.type === 'text') {
        const val = field.value || '';
        const fSize = Math.min(fh * 0.55, 10);
        page.drawRectangle({ x: fx, y: fy, width: fw, height: fh,
          borderColor: hexToColour('#6366f1'), borderWidth: 0.5,
          color: rgb(0.97, 0.97, 1), opacity: 0.6 });
        page.drawText(val, { x: fx + 3, y: fy + fh * 0.25, size: fSize,
          font: helvetica, color: rgb(0.1, 0.1, 0.1), maxWidth: fw - 6 });
      } else if (field.type === 'checkbox') {
        const checked = field.value === 'true' || field.value === true;
        const sz = Math.min(fw, fh);
        page.drawRectangle({ x: fx, y: fy + (fh - sz) / 2, width: sz, height: sz,
          borderColor: hexToColour('#6366f1'), borderWidth: 1,
          color: checked ? hexToColour('#6366f1') : rgb(1,1,1) });
        if (checked) {
          page.drawText('✓', { x: fx + 2, y: fy + (fh - sz) / 2 + 2, size: sz * 0.75,
            font: helveticaBold, color: rgb(1, 1, 1) });
        }
      }
    } catch (e) {
      console.warn('[signing] field embed error:', e.message);
    }
  }

  // ── Add completion certificate as last page ──────────────────────────────
  const certPage = pdfDoc.addPage([595, 842]); // A4
  const { width: cw, height: ch } = certPage.getSize();

  // Header bar
  certPage.drawRectangle({ x: 0, y: ch - 80, width: cw, height: 80, color: hexToColour('#6366f1') });
  certPage.drawText('Signing Certificate', { x: 40, y: ch - 48, size: 20, font: helveticaBold, color: rgb(1,1,1) });
  certPage.drawText(env.title, { x: 40, y: ch - 68, size: 11, font: helvetica, color: rgb(0.85,0.85,1) });

  let yPos = ch - 110;
  certPage.drawText('Envelope ID:', { x: 40, y: yPos, size: 9, font: helveticaBold, color: rgb(0.4,0.4,0.4) });
  certPage.drawText(env.id, { x: 130, y: yPos, size: 9, font: helvetica, color: rgb(0.3,0.3,0.3) });
  yPos -= 18;
  certPage.drawText('Completed:', { x: 40, y: yPos, size: 9, font: helveticaBold, color: rgb(0.4,0.4,0.4) });
  certPage.drawText(new Date().toISOString(), { x: 130, y: yPos, size: 9, font: helvetica, color: rgb(0.3,0.3,0.3) });

  yPos -= 30;
  certPage.drawText('Signers', { x: 40, y: yPos, size: 13, font: helveticaBold, color: rgb(0.1,0.1,0.1) });
  certPage.drawLine({ start: { x: 40, y: yPos - 4 }, end: { x: cw - 40, y: yPos - 4 },
    thickness: 0.5, color: rgb(0.8,0.8,0.8) });
  yPos -= 22;

  const signers = db.prepare('SELECT * FROM sign_signers WHERE envelope_id = ? ORDER BY order_idx').all(env.id);
  for (const s of signers) {
    certPage.drawText(`${s.name}  <${s.email}>`, { x: 40, y: yPos, size: 10, font: helveticaBold, color: rgb(0.1,0.1,0.1) });
    yPos -= 14;
    certPage.drawText(`Status: ${s.status.toUpperCase()}   Signed: ${s.signed_at || 'N/A'}   IP: ${s.ip || 'N/A'}`,
      { x: 40, y: yPos, size: 8, font: helvetica, color: rgb(0.5,0.5,0.5) });
    yPos -= 20;
    if (yPos < 60) break;
  }

  // Verification box
  certPage.drawRectangle({ x: 40, y: 38, width: cw - 80, height: 32,
    color: rgb(0.95, 0.96, 1), borderColor: rgb(0.7, 0.74, 0.93), borderWidth: 0.5 });
  certPage.drawText('Verify:', { x: 50, y: 60, size: 8, font: helveticaBold, color: rgb(0.3, 0.3, 0.5) });
  certPage.drawText(baseUrl ? `${baseUrl}/verify?id=${env.id}` : `Envelope ID: ${env.id}`,
    { x: 86, y: 60, size: 8, font: helvetica, color: rgb(0.18, 0.3, 0.82) });
  certPage.drawText('SHA-256 fingerprint of this document is available at the verification URL.',
    { x: 50, y: 45, size: 7.5, font: helvetica, color: rgb(0.5,0.5,0.55) });

  // Footer
  certPage.drawText('This document was electronically signed via DocumentNeo.',
    { x: 40, y: 24, size: 7.5, font: helvetica, color: rgb(0.6,0.6,0.6) });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = router;
