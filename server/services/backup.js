'use strict';

// Periodic DB + .env backup.
// Set BACKUP_PATH in .env to enable; leave unset to skip entirely.

const fs   = require('fs');
const path = require('path');
const db   = require('../database');

const BACKUP_PATH     = process.env.BACKUP_PATH             || null;
const INTERVAL_HOURS  = parseInt(process.env.BACKUP_INTERVAL_HOURS) || 24;
const KEEP            = parseInt(process.env.BACKUP_KEEP)            || 10;

function timestamp() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    now.getFullYear()               + '-' +
    pad(now.getMonth() + 1)         + '-' +
    pad(now.getDate())              + '_' +
    pad(now.getHours())             + '-' +
    pad(now.getMinutes())           + '-' +
    pad(now.getSeconds())
  );
}

function pruneOldBackups(backupRoot) {
  let entries;
  try {
    entries = fs.readdirSync(backupRoot, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(e.name))
      .map(e => e.name)
      .sort();                    // oldest first
  } catch (_) {
    return;
  }

  const excess = entries.length - KEEP;
  if (excess <= 0) return;

  for (let i = 0; i < excess; i++) {
    const dir = path.join(backupRoot, entries[i]);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[backup] Pruned old snapshot: ${entries[i]}`);
    } catch (err) {
      console.warn(`[backup] Could not prune ${dir}:`, err.message);
    }
  }
}

async function runBackup() {
  if (!BACKUP_PATH) return;   // silently skip if not configured

  const backupRoot = path.resolve(BACKUP_PATH);
  const snapDir    = path.join(backupRoot, timestamp());

  try {
    fs.mkdirSync(snapDir, { recursive: true });
  } catch (err) {
    console.error('[backup] Cannot create snapshot directory:', err.message);
    return;
  }

  const dbDest = path.join(snapDir, 'vault.db');
  try {
    await db.backup(dbDest);
    const sizeMb = (fs.statSync(dbDest).size / 1_048_576).toFixed(1);
    console.log(`[backup] Database saved → ${dbDest} (${sizeMb} MB)`);
  } catch (err) {
    console.error('[backup] Database backup failed:', err.message);
    try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch (_) {}
    return;
  }

  const envSrc = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envSrc)) {
    try {
      fs.copyFileSync(envSrc, path.join(snapDir, '.env'));
    } catch (err) {
      console.warn('[backup] Could not copy .env:', err.message);
    }
  }

  pruneOldBackups(backupRoot);
  console.log(`[backup] Snapshot complete: ${path.basename(snapDir)}`);
}

let _timer = null;

function startBackup() {
  if (!BACKUP_PATH) {
    console.log('[backup] BACKUP_PATH not set — backups disabled.');
    return;
  }

  console.log(`[backup] Backup path: ${path.resolve(BACKUP_PATH)}`);
  console.log(`[backup] Interval: every ${INTERVAL_HOURS}h, keeping ${KEEP} snapshots`);

  setTimeout(() => runBackup().catch(err => console.error('[backup] Error:', err.message)), 5000);

  const intervalMs = INTERVAL_HOURS * 60 * 60 * 1000;
  _timer = setInterval(
    () => runBackup().catch(err => console.error('[backup] Error:', err.message)),
    intervalMs
  );
  if (_timer.unref) _timer.unref();
}

function stopBackup() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

async function triggerBackup() {
  return runBackup();
}

module.exports = { startBackup, stopBackup, triggerBackup };
