'use strict';

const fs       = require('fs');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const chokidar = require('chokidar');
const pdfParse = require('pdf-parse');
const db       = require('../database');
const { autoProcess } = require('./ai');

let watcher = null;

function getSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch (_) { return null; }
}

function getIngestUser() {
  // Ingest documents under the first admin user
  return db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
}

async function ingestFile(filePath) {
  const ext      = path.extname(filePath).toLowerCase();
  const allowed  = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.txt'];
  if (!allowed.includes(ext)) return;

  const mimeMap = {
    '.pdf':  'application/pdf',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.webp': 'image/webp',
    '.gif':  'image/gif',
    '.txt':  'text/plain',
  };

  try {
    // Wait briefly for the file to finish writing
    await new Promise(r => setTimeout(r, 1500));

    const buffer   = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const mimeType = mimeMap[ext] || 'application/octet-stream';
    const maxMb    = parseInt(getSetting('max_file_mb') || '50');

    if (buffer.length > maxMb * 1024 * 1024) {
      console.warn(`[watcher] Skipping ${filename} — exceeds size limit of ${maxMb} MB.`);
      return;
    }

    let textContent = null;
    if (mimeType === 'application/pdf') {
      try {
        const parsed = await pdfParse(buffer);
        textContent  = parsed.text ? parsed.text.slice(0, 100000) : null;
      } catch (_) {}
    } else if (mimeType === 'text/plain') {
      textContent = buffer.toString('utf8').slice(0, 100000);
    }

    const user = getIngestUser();
    if (!user) {
      console.warn('[watcher] No admin user found — cannot ingest document. Create an account first.');
      return;
    }

    const id    = uuidv4();
    const title = filename.replace(/\.[^.]+$/, ''); // strip extension

    db.prepare(`
      INSERT INTO documents (id, title, filename, mime_type, file_size, content, text_content, user_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'watch')
    `).run(id, title, filename, mimeType, buffer.length, buffer, textContent, user.id);

    console.log(`[watcher] Ingested: ${filename} → ${id}`);

    // AI auto-processing
    if (getSetting('ai_enabled') === 'true') {
      autoProcess(id, textContent, user.id).catch(() => {});
    }

    // Move file to processed sub-folder so it isn't re-ingested
    const processedDir = path.join(path.dirname(filePath), '.processed');
    if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });
    fs.renameSync(filePath, path.join(processedDir, `${Date.now()}_${filename}`));
  } catch (err) {
    console.error(`[watcher] Failed to ingest ${filePath}:`, err.message);
  }
}

function startWatcher() {
  const folder  = process.env.WATCH_FOLDER  || getSetting('watch_folder')  || './inbox';
  const enabled = (process.env.WATCH_ENABLED || getSetting('watch_enabled') || 'false') === 'true';

  if (!enabled) {
    console.log('[watcher] Watch folder disabled — skipping.');
    return;
  }

  if (!fs.existsSync(folder)) {
    try { fs.mkdirSync(folder, { recursive: true }); }
    catch (_) { console.warn('[watcher] Cannot create watch folder:', folder); return; }
  }

  watcher = chokidar.watch(folder, {
    ignored:         /(^|[/\\])\.(processed|git)/, // skip hidden dirs
    persistent:      true,
    ignoreInitial:   false,
    awaitWriteFinish:{ stabilityThreshold: 2000, pollInterval: 200 },
    depth:           0, // only top-level files
  });

  watcher
    .on('add',   fp => ingestFile(fp))
    .on('error', err => console.error('[watcher] Error:', err.message));

  console.log(`[watcher] Watching: ${path.resolve(folder)}`);
}

function stopWatcher() {
  if (watcher) {
    watcher.close().then(() => console.log('[watcher] Stopped.'));
    watcher = null;
  }
}

function restartWatcher() {
  stopWatcher();
  setTimeout(startWatcher, 500);
}

module.exports = { startWatcher, stopWatcher, restartWatcher };
