'use strict';

const jwt = require('jsonwebtoken');
const db  = require('../database');

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET must be at least 32 characters. Refusing to start.');
  process.exit(1);
}

/** Sign a JWT for a given user object. */
function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, username: user.username },
    SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h', algorithm: 'HS256' }
  );
}

/** Express middleware — attaches req.user or responds 401. */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  let payload;
  try {
    payload = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const user = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(payload.sub);
  if (!user) return res.status(401).json({ error: 'User not found' });

  req.user = user;
  next();
}

/** Middleware that additionally requires the admin role. */
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin')
      return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

module.exports = { signToken, requireAuth, requireAdmin };
