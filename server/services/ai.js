'use strict';

const { OpenAI } = require('openai');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getClient() {
  // ENV takes priority; fallback to DB-stored key (legacy)
  const apiKey = process.env.OPENAI_API_KEY || getSetting('openai_api_key');
  if (!apiKey || apiKey === '••••••••') throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY in .env');
  return new OpenAI({ apiKey });
}

/**
 * Run AI auto-processing on a newly uploaded document.
 * Detects: tags, document type, correspondent, summary.
 */
async function autoProcess(documentId, textContent, userId) {
  try {
    if (!textContent || textContent.trim().length < 20) return;

    const model = process.env.OPENAI_MODEL || getSetting('ai_model') || 'gpt-5-mini';

    // Per-user preferences — fall back to 'true' if columns don't exist yet
    let userPrefs = {};
    if (userId) {
      try {
        userPrefs = db.prepare(
          'SELECT pref_ai_auto_tag, pref_ai_auto_type, pref_ai_auto_summary, pref_ai_auto_correspondent, pref_ai_auto_create, pref_ai_auto_title, pref_ai_custom_instructions FROM users WHERE id = ?'
        ).get(userId) || {};
      } catch (_) {}
    }
    const autoTag           = (userPrefs.pref_ai_auto_tag           ?? 'true') !== 'false';
    const autoType          = (userPrefs.pref_ai_auto_type          ?? 'true') !== 'false';
    const autoSummary       = (userPrefs.pref_ai_auto_summary       ?? 'true') !== 'false';
    const autoCorrespondent = (userPrefs.pref_ai_auto_correspondent ?? 'true') !== 'false';
    const aiAutoCreate      = (userPrefs.pref_ai_auto_create        ?? 'true') !== 'false';
    const autoTitle         = (userPrefs.pref_ai_auto_title         ?? 'true') !== 'false';
    const customInstructions = (userPrefs.pref_ai_custom_instructions || '').trim();

    const client  = getClient();
    const snippet = textContent.slice(0, 4000);

    const existingTags           = db.prepare('SELECT id, name FROM tags WHERE user_id = ?').all(userId);
    const existingTypes          = db.prepare('SELECT id, name FROM document_types WHERE user_id = ?').all(userId);
    const existingCorrespondents = db.prepare('SELECT id, name FROM correspondents WHERE user_id = ?').all(userId);

    const tagNames  = existingTags.map(t => t.name);
    const typeNames = existingTypes.map(t => t.name);
    const corrNames = existingCorrespondents.map(c => c.name);

    const systemPrompt = `You are a document classification assistant for a private document vault. Your job is to analyse a document excerpt and return structured metadata as JSON.

Your output will be used to automatically tag, categorise, and organise documents. Be precise and conservative — wrong labels cause clutter.

━━ TAGS ━━
Tags are short, lowercase keyword labels (e.g. "invoice", "tax", "2024", "urgent").
- Return 1–3 tags MAX. Fewer focused tags beat many vague ones.
- ALWAYS reuse an existing tag when it fits. Check the list carefully before inventing one.
- New tags are only acceptable when NO existing tag covers the concept at all.
- Never use the document type as a tag (e.g. don't tag "invoice" if that is the type).
- Tags must be lowercase single words or short hyphenated phrases.

━━ DOCUMENT TYPE ━━
Document type is a broad category label (e.g. "Invoice", "Contract", "Receipt", "Letter", "Report", "Tax Return").
- Pick ONE type. Use an EXACT existing type name if any fits — even loosely.
- Only invent a new type if the document truly belongs to a category not covered by ANY existing type.
- When in doubt, prefer a broader existing type over a new narrow one.
- Return null if the document truly cannot be categorised.

━━ CORRESPONDENT ━━
Correspondent is the person or organisation that sent or issued the document (the other party, not the user).
- Use the EXACT name from the existing list if the sender appears there.
- Only provide a new name if the sender is genuinely absent from the list.
- Return null if no sender can be identified from the document.

━━ GENERAL RULES ━━
- When unsure, return null rather than guessing.
- Never suggest variants, plurals, or abbreviations of existing labels.
- Respond with ONLY valid JSON — no prose, no markdown, no explanation.

Existing tags: ${JSON.stringify(tagNames)}.
Existing document types: ${JSON.stringify(typeNames)}.
Existing correspondents: ${JSON.stringify(corrNames)}.${customInstructions ? '\n\nAdditional instructions from the user:\n' + customInstructions : ''}`;

    const fields = [];
    if (autoTitle)         fields.push(`"suggested_title": string — a concise, descriptive title (5–10 words). Use null to keep the existing filename-based title.`);
    if (autoTag)           fields.push(`"suggested_tags": array of 1–3 lowercase tag strings. Reuse existing tags wherever possible. Empty array [] if no tags apply.`);
    if (autoType)          fields.push(`"suggested_type": string — the single best-matching document type. Use an existing type name exactly if it fits. Use null if nothing fits.`);
    if (autoCorrespondent) fields.push(`"suggested_correspondent": string — the sender/issuer of this document. Match exact spelling from existing correspondents list. Use null if not identifiable.`);
    if (autoSummary)       fields.push(`"summary": string — 2–4 sentence plain-text summary of what this document is and its key information.`);

    if (!fields.length) return;

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `Document text (excerpt):\n"""\n${snippet}\n"""\n\nReturn JSON with:\n${fields.join('\n')}` }
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 600,
    });

    let result;
    try { result = JSON.parse(completion.choices[0].message.content); }
    catch (_) { return; }

    const PALETTE = ['#22c55e','#3b82f6','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899'];

    // Returns true when the AI returned a placeholder-null string instead of nothing
    const aiBlank = s => !s || ['null','none','n/a','unknown'].includes(s.toLowerCase().trim());

    // Normalize a label string for fuzzy dedup checking
    const norm = (s) => s.toLowerCase().trim().replace(/[_\-\s]+/g, ' ').replace(/s$/,''); // strip trailing 's' for plural

    const applyTx = db.transaction(() => {
      // ── Title ───────────────────────────────────────────────────────────
      if (autoTitle && typeof result.suggested_title === 'string') {
        const title = result.suggested_title.trim().slice(0, 255);
        if (title && !aiBlank(title)) {
          db.prepare(
            `UPDATE documents SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
          ).run(title, documentId);
        }
      }

      // ── Tags ────────────────────────────────────────────────────────────
      if (autoTag && Array.isArray(result.suggested_tags)) {
        for (const tagName of result.suggested_tags.slice(0, 3)) {  // max 3
          if (typeof tagName !== 'string') continue;
          const name = tagName.trim().toLowerCase().slice(0, 60);
          if (!name || aiBlank(name)) continue;
          // 1. Exact match (COLLATE NOCASE handles case)
          let tag = db.prepare('SELECT id FROM tags WHERE name = ? AND user_id = ?').get(name, userId);
          // 2. Fuzzy dedup: if AI suggests a variant of an existing tag, reuse it
          if (!tag) {
            const fuzzy = existingTags.find(t => norm(t.name) === norm(name));
            if (fuzzy) tag = fuzzy;
          }
          if (!tag) {
            if (!aiAutoCreate) continue;
            db.prepare('INSERT OR IGNORE INTO tags (id, name, color, user_id) VALUES (?, ?, ?, ?)').run(
              uuidv4(), name, PALETTE[Math.floor(Math.random() * PALETTE.length)], userId
            );
            tag = db.prepare('SELECT id FROM tags WHERE name = ? AND user_id = ?').get(name, userId);
          }
          if (tag) {
            db.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)').run(documentId, tag.id);
          }
        }
      }

      // ── Document Type ───────────────────────────────────────────────────
      if (autoType && typeof result.suggested_type === 'string') {
        const typeName = result.suggested_type.trim().slice(0, 60);
        if (typeName && !aiBlank(typeName)) {
          let type = db.prepare('SELECT id FROM document_types WHERE name = ? AND user_id = ?').get(typeName, userId);
          // Fuzzy dedup for types
          if (!type) {
            const fuzzy = existingTypes.find(t => norm(t.name) === norm(typeName));
            if (fuzzy) type = fuzzy;
          }
          if (!type && aiAutoCreate) {
            db.prepare('INSERT OR IGNORE INTO document_types (id, name, color, user_id) VALUES (?, ?, ?, ?)').run(
              uuidv4(), typeName, '#6366f1', userId
            );
            type = db.prepare('SELECT id FROM document_types WHERE name = ? AND user_id = ?').get(typeName, userId);
          }
          if (type) {
            db.prepare(
              `UPDATE documents SET type_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
            ).run(type.id, documentId);
          }
        }
      }

      // ── Correspondent ───────────────────────────────────────────────────
      if (autoCorrespondent && typeof result.suggested_correspondent === 'string') {
        const corrName = result.suggested_correspondent.trim().slice(0, 100);
        if (corrName && !aiBlank(corrName)) {
          let corr = db.prepare('SELECT id FROM correspondents WHERE name = ? AND user_id = ?').get(corrName, userId);
          // Fuzzy dedup for correspondents
          if (!corr) {
            const fuzzy = existingCorrespondents.find(c => norm(c.name) === norm(corrName));
            if (fuzzy) corr = fuzzy;
          }
          if (!corr && aiAutoCreate) {
            db.prepare('INSERT OR IGNORE INTO correspondents (id, name, color, user_id) VALUES (?, ?, ?, ?)').run(
              uuidv4(), corrName, PALETTE[Math.floor(Math.random() * PALETTE.length)], userId
            );
            corr = db.prepare('SELECT id FROM correspondents WHERE name = ? AND user_id = ?').get(corrName, userId);
          }
          if (corr) {
            db.prepare(
              `UPDATE documents SET correspondent_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
            ).run(corr.id, documentId);
          }
        }
      }

      // ── Summary ─────────────────────────────────────────────────────────
      if (autoSummary && typeof result.summary === 'string') {
        const summary = result.summary.trim().slice(0, 1000);
        if (summary && !aiBlank(summary)) {
          db.prepare(
            `UPDATE documents SET notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
          ).run(summary, documentId);
        }
      }
    });

    applyTx();
    console.log(`[AI] Auto-processed document ${documentId} → tags/type/correspondent/summary applied.`);

  } catch (err) {
    console.error(`[AI] autoProcess failed for ${documentId}:`, err.message);
  }
}

/**
 * Ask the AI a question about a specific document.
 */
async function askAboutDocument(documentId, question, userId) {
  let customInstructions = '';
  try {
    const u = db.prepare('SELECT pref_ai_custom_instructions FROM users WHERE id = ?').get(userId);
    customInstructions = (u?.pref_ai_custom_instructions || '').trim();
  } catch (_) {}

  const doc = db.prepare(`
    SELECT d.text_content, d.title, d.notes,
           dt.name as type_name, c.name as correspondent_name,
           GROUP_CONCAT(t.name, ', ') as tag_names
    FROM documents d
    LEFT JOIN document_types dt ON d.type_id = dt.id
    LEFT JOIN correspondents c ON d.correspondent_id = c.id
    LEFT JOIN document_tags dta ON d.id = dta.document_id
    LEFT JOIN tags t ON dta.tag_id = t.id
    WHERE d.id = ? AND d.user_id = ?
    GROUP BY d.id
  `).get(documentId, userId);

  if (!doc) throw new Error('Document not found.');
  if (!doc.text_content) throw new Error('No extractable text in this document.');

  const model  = getSetting('ai_model') || 'gpt-5-mini';
  const client = getClient();

  const context = [
    `Title: ${doc.title}`,
    doc.type_name         ? `Type: ${doc.type_name}` : '',
    doc.correspondent_name ? `From/To: ${doc.correspondent_name}` : '',
    doc.tag_names         ? `Tags: ${doc.tag_names}` : '',
    doc.notes             ? `Summary: ${doc.notes}` : '',
  ].filter(Boolean).join('\n');

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: `You are a helpful document assistant. Answer questions about the provided document clearly and concisely. If the information is not in the document, say so honestly.${customInstructions ? '\n\nAdditional instructions from the user:\n' + customInstructions : ''}` },
      { role: 'user',   content: `${context}\n\nDocument text:\n"""\n${doc.text_content.slice(0, 6000)}\n"""\n\nQuestion: ${question}` }
    ],
    max_completion_tokens: 800,
  });
  return completion.choices[0].message.content.trim();
}

/**
 * Generate a fresh summary for a document on demand.
 */
async function summariseDocument(documentId, userId) {
  const doc = db.prepare('SELECT text_content, title FROM documents WHERE id = ? AND user_id = ?').get(documentId, userId);
  if (!doc) throw new Error('Document not found.');
  if (!doc.text_content) throw new Error('No extractable text in this document.');

  const model  = getSetting('ai_model') || 'gpt-5-mini';
  const client = getClient();

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: 'You are a document summarisation assistant. Write concise, factual summaries in 2-4 sentences.' },
      { role: 'user',   content: `Summarise this document titled "${doc.title}":\n\n${doc.text_content.slice(0, 5000)}` }
    ],
    max_completion_tokens: 300,
  });

  const summary = completion.choices[0].message.content.trim();
  db.prepare(`UPDATE documents SET notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(summary, documentId);
  return summary;
}

module.exports = { autoProcess, askAboutDocument, summariseDocument };
