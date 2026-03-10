'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db      = require('../database');
const { requireAuth } = require('../middleware/auth');
const { OpenAI }      = require('openai');
const { askAboutDocument, summariseDocument, autoProcess } = require('../services/ai');

const router = express.Router();
router.use(requireAuth);

const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  message: { error: 'AI rate limit reached, please wait a moment.' }
});

function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null;
}

function hasAiKey() {
  const apiKey = process.env.OPENAI_API_KEY || getSetting('openai_api_key');
  return !!(apiKey && apiKey !== '••••••••');
}

function aiGuard(req, res, next) {
  if (!hasAiKey()) return res.status(503).json({ error: 'AI not configured. Add an OpenAI API key in settings or set OPENAI_API_KEY in .env.' });
  next();
}

/* ── POST /api/ai/ask/:docId ── Ask question about a document */
router.post('/ask/:docId', aiGuard, aiLimiter, async (req, res) => {
  const question = typeof req.body.question === 'string' ? req.body.question.trim().slice(0, 500) : '';
  if (!question) return res.status(400).json({ error: 'Question is required.' });
  const owned = db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?').get(req.params.docId, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Document not found.' });
  try {
    const answer = await askAboutDocument(req.params.docId, question, req.user.id);
    res.json({ answer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/ai/summarise/:docId ── Re-generate summary */
router.post('/summarise/:docId', aiGuard, aiLimiter, async (req, res) => {
  const owned = db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?').get(req.params.docId, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Document not found.' });
  try {
    const summary = await summariseDocument(req.params.docId, req.user.id);
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/ai/retag/:docId ── Re-run auto tagging */
router.post('/retag/:docId', aiGuard, aiLimiter, async (req, res) => {
  const doc = db.prepare('SELECT text_content, user_id FROM documents WHERE id = ? AND user_id = ?').get(req.params.docId, req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  try {
    await autoProcess(req.params.docId, doc.text_content, doc.user_id);
    const tags = db.prepare(`
      SELECT t.id, t.name, t.color FROM tags t
      INNER JOIN document_tags dt ON t.id = dt.tag_id
      WHERE dt.document_id = ?
    `).all(req.params.docId);
    const updated = db.prepare('SELECT type_id, notes FROM documents WHERE id = ?').get(req.params.docId);
    res.json({ message: 'AI re-tagging complete.', tags, type_id: updated.type_id, notes: updated.notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/ai/chat ── RAG chat across all documents */
router.post('/chat', aiGuard, aiLimiter, async (req, res) => {
  const question = typeof req.body.question === 'string' ? req.body.question.trim().slice(0, 600) : '';
  const history  = Array.isArray(req.body.history) ? req.body.history.slice(-12) : [];
  if (!question) return res.status(400).json({ error: 'Question is required.' });

  try {
    // 1. FTS search for the most relevant documents
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT d.id, d.title,
               COALESCE(d.text_content, '') AS text_content,
               COALESCE(d.notes, '')        AS notes
        FROM documents d
        INNER JOIN documents_fts ON d.rowid = documents_fts.rowid
        WHERE documents_fts MATCH ? AND d.user_id = ?
        ORDER BY rank
        LIMIT 6
      `).all(question.replace(/[^\w\s]/g, ' '), req.user.id);
    } catch (_) {}

    // 2. Keyword fallback when FTS returns nothing
    if (!rows.length) {
      const words = question.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 6);
      if (words.length) {
        const likeClauses = words.map(() => "(LOWER(title) LIKE ? OR LOWER(COALESCE(text_content,'')) LIKE ?)").join(' OR ');
        const likeArgs    = words.flatMap(w => [`%${w}%`, `%${w}%`]);
        rows = db.prepare(
          `SELECT id, title, COALESCE(text_content,'') AS text_content, COALESCE(notes,'') AS notes
           FROM documents WHERE user_id = ? AND (${likeClauses}) LIMIT 6`
        ).all(req.user.id, ...likeArgs);
      }
    }

    // 3. Build context string — 1 200 chars per doc max
    const contextParts = rows.map(d => {
      const body = (d.text_content || d.notes || '').trim().slice(0, 1200);
      return `=== Document: "${d.title}" ===\n${body || '(no text content)'}`;
    });
    const context = contextParts.join('\n\n') || 'No matching documents found in the vault.';

    // 4. Build message array
    const apiKey = process.env.OPENAI_API_KEY || getSetting('openai_api_key');
    if (!apiKey || apiKey === '••••••••') return res.status(503).json({ error: 'OpenAI API key not configured.' });
    const client = new OpenAI({ apiKey });
    const model  = process.env.OPENAI_MODEL || getSetting('ai_model') || 'gpt-4o-mini';

    let customInstructions = '';
    try {
      const u = db.prepare('SELECT pref_ai_custom_instructions FROM users WHERE id = ?').get(req.user.id);
      customInstructions = (u?.pref_ai_custom_instructions || '').trim();
    } catch (_) {}

    const messages = [
      {
        role: 'system',
        content: `You are a helpful document assistant for a private vault. Answer questions based ONLY on the document excerpts below.
If the answer cannot be determined from these excerpts, say so clearly.
Be concise, accurate, and cite which document(s) you drew the answer from.${customInstructions ? '\n\nAdditional instructions from the user:\n' + customInstructions : ''}

${context}`,
      },
      ...history.map(h => ({ role: h.role, content: String(h.content).slice(0, 800) })),
      { role: 'user', content: question },
    ];

    const completion = await client.chat.completions.create({ model, messages, max_tokens: 700, temperature: 0.3 });
    const answer     = completion.choices[0].message.content;
    const sources    = rows.map(d => ({ id: d.id, title: d.title }));

    res.json({ answer, sources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
