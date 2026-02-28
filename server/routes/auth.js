'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const db = require('../database');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Use real socket address so X-Forwarded-For cannot be used to bypass
  keyGenerator: (req) => req.socket.remoteAddress || 'unknown',
  message: { error: 'Too many requests, please try again later.' }
});


function sanitise(str, max = 200) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max).replace(/[<>]/g, '');
}

/* ── POST /api/auth/register ─────────────────────────── */
router.post('/register', authLimiter, (req, res) => {
  const _envReg = process.env.REGISTRATION_OPEN;
  const regOpen = (_envReg !== undefined && _envReg !== '')
    ? _envReg
    : (db.prepare("SELECT value FROM settings WHERE key='registration_open'").get()?.value ?? 'true');
  if (regOpen === 'false') {
    // Allow registration only if there are no users yet (bootstrap)
    const count = db.prepare('SELECT COUNT(*) as n FROM users').get();
    if (count.n > 0) return res.status(403).json({ error: 'Registration is currently disabled.' });
  }

  const username = sanitise(req.body.username, 50);
  const email = sanitise(req.body.email, 100).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!username || username.length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email address.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) return res.status(409).json({ error: 'Username or email already taken.' });

  const hash = bcrypt.hashSync(password, 12);
  const id = uuidv4();
  // First user becomes admin
  const isAdmin = db.prepare('SELECT COUNT(*) as n FROM users').get().n === 0;
  db.prepare(
    'INSERT INTO users (id, username, email, password, role) VALUES (?, ?, ?, ?, ?)'
  ).run(id, username, email, hash, isAdmin ? 'admin' : 'user');

  audit(id, 'register', id, null, req.ip);
  const token = signToken({ id, username, role: isAdmin ? 'admin' : 'user' });
  res.status(201).json({ token, username, role: isAdmin ? 'admin' : 'user' });
});

/* ── POST /api/auth/login ────────────────────────────── */
router.post('/login', authLimiter, (req, res) => {
  const identifier = sanitise(req.body.identifier || req.body.username || req.body.email, 100);
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!identifier || !password)
    return res.status(400).json({ error: 'Identifier and password are required.' });

  const user = db.prepare(
    'SELECT id, username, email, role, password, totp_enabled, totp_secret FROM users WHERE username = ? OR email = ?'
  ).get(identifier.toLowerCase(), identifier.toLowerCase());

  // Always run bcrypt to prevent username-enumeration via timing differences
  const DUMMY_HASH = '$2a$12$invalidhashpadding000000000000000000000000000000000000000';
  const valid = bcrypt.compareSync(password, user ? user.password : DUMMY_HASH);
  if (!user || !valid)
    return res.status(401).json({ error: 'Invalid credentials.' });

  // 2FA Check
  if (user.totp_enabled) {
    const totpToken = typeof req.body.totp === 'string' ? req.body.totp.replace(/\s+/g, '') : '';
    if (!totpToken) return res.status(403).json({ "2fa_required": true });

    const verified = speakeasy.totp.verify({
      secret: user.totp_secret,
      encoding: 'base32',
      token: totpToken,
      window: 1 // allow 30 seconds drift either way
    });

    if (!verified) return res.status(401).json({ error: 'Invalid 2FA code.' });
  }

  db.prepare("UPDATE users SET last_login = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(user.id);
  audit(user.id, 'login', null, null, req.ip);

  const token = signToken(user);
  res.json({ token, username: user.username, role: user.role });
});

/* ── GET /api/auth/me ────────────────────────────────── */
router.get('/me', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id, username, email, role, pref_ai_auto_tag, pref_ai_auto_type, pref_ai_auto_summary, pref_ai_auto_correspondent, pref_ai_auto_create, pref_ai_auto_title, pref_ai_custom_instructions, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  res.json({
    ...u,
    totp_enabled: !!u.totp_enabled
  });
});

/* ── 2FA endpoints ───────────────────────────────────── */

router.get('/2fa/generate', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT email, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled' });

  const secret = speakeasy.generateSecret({
    name: `DocumentNeo (${user.email})`
  });

  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret.base32, req.user.id);

  try {
    const dataUrl = await qrcode.toDataURL(secret.otpauth_url);
    res.json({ secret: secret.base32, qrcode: dataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Error generating QR code' });
  }
});

router.post('/2fa/verify', requireAuth, (req, res) => {
  const token = typeof req.body.token === 'string' ? req.body.token.replace(/\s+/g, '') : '';
  if (!token) return res.status(400).json({ error: 'Token is required' });

  const user = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled' });
  if (!user.totp_secret) return res.status(400).json({ error: '2FA not generated yet' });

  const verified = speakeasy.totp.verify({
    secret: user.totp_secret,
    encoding: 'base32',
    token: token,
    window: 1
  });

  if (verified) {
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.user.id);
    audit(req.user.id, 'enable_2fa', null, null, req.ip);
    res.json({ ok: true, message: '2FA enabled successfully' });
  } else {
    res.status(400).json({ error: 'Invalid token' });
  }
});

router.post('/2fa/disable', requireAuth, (req, res) => {
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const token = typeof req.body.token === 'string' ? req.body.token.replace(/\s+/g, '') : '';

  if (!password || !token) return res.status(400).json({ error: 'Password and token are required' });

  const user = db.prepare('SELECT password, totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!user.totp_enabled) return res.status(400).json({ error: '2FA is not enabled' });

  if (!bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const verified = speakeasy.totp.verify({
    secret: user.totp_secret,
    encoding: 'base32',
    token: token,
    window: 1
  });

  if (verified) {
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.user.id);
    audit(req.user.id, 'disable_2fa', null, null, req.ip);
    res.json({ ok: true, message: '2FA disabled successfully' });
  } else {
    res.status(400).json({ error: 'Invalid token' });
  }
});

/* ── PATCH /api/auth/me/preferences ─────────────────── */
router.patch('/me/preferences', requireAuth, (req, res) => {
  const allowed = ['pref_ai_auto_tag', 'pref_ai_auto_type', 'pref_ai_auto_summary', 'pref_ai_auto_correspondent', 'pref_ai_auto_create', 'pref_ai_auto_title'];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (key in req.body) {
      sets.push(`${key} = ?`);
      vals.push(req.body[key] === true || req.body[key] === 'true' ? 'true' : 'false');
    }
  }
  if (typeof req.body.pref_ai_custom_instructions === 'string') {
    sets.push('pref_ai_custom_instructions = ?');
    vals.push(req.body.pref_ai_custom_instructions.trim().slice(0, 2000));
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  vals.push(req.user.id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ message: 'Preferences saved.' });
});

/* ── POST /api/auth/change-password ─────────────────── */
router.post('/change-password', requireAuth, authLimiter, (req, res) => {
  const current = typeof req.body.current === 'string' ? req.body.current : '';
  const newPass = typeof req.body.password === 'string' ? req.body.password : '';

  if (!current) return res.status(400).json({ error: 'Current password is required.' });
  if (newPass.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });

  const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current, user.password))
    return res.status(401).json({ error: 'Current password is incorrect.' });

  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(newPass, 12), req.user.id);
  audit(req.user.id, 'change_password', req.user.id, null, req.ip);
  res.json({ message: 'Password changed successfully.' });
});

function audit(userId, action, targetId, details, ip) {
  try {
    db.prepare(
      'INSERT INTO audit_log (user_id, action, target_id, details, ip) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, action, targetId, details ? JSON.stringify(details) : null, ip || null);
  } catch (_) { /* non-fatal */ }
}

module.exports = router;
