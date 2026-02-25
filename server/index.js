'use strict';

require('dotenv').config();

const express    = require('express');
const helmet     = require('helmet');
const path       = require('path');
const rateLimit  = require('express-rate-limit');

const authRoutes     = require('./routes/auth');
const docRoutes      = require('./routes/documents');
const { tagRouter, typeRouter } = require('./routes/tags');
const settingsRoutes       = require('./routes/settings');
const aiRoutes             = require('./routes/ai');
const correspondentRoutes  = require('./routes/correspondents');
const { router: mcpRoutes, oauthMeta } = require('./routes/mcp');
const signingRoutes = require('./routes/signing');

const { startWatcher } = require('./services/watcher');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;

/* Security headers — customised for inline scripts in our pure-JS UI */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:      ["'self'"],
      scriptSrc:       ["'self'"],                      // no unsafe-inline: all scripts are external files
      scriptSrcAttr:   ["'unsafe-inline'"],             // inline onclick= in dynamically-built HTML strings
                                                        // TODO: migrate to event delegation to remove this
      styleSrc:        ["'self'", "'unsafe-inline'"],   // required for dynamic style="color:…" on tag/type/signer chips
                                                        // cannot use hashes/nonces for element-level style attrs
      fontSrc:         ["'self'", 'data:'],
      imgSrc:          ["'self'", 'data:', 'blob:'],
      connectSrc:      ["'self'"],
      objectSrc:       ["'none'"],
      frameSrc:        ["'self'", 'blob:'],  // PDF inline viewer in iframe — blob: required for PDF blob URLs
      frameAncestors:  ["'self'"],           // allow this app to iframe its own /view endpoint
      workerSrc:       ["'self'", 'blob:'],  // PDF.js web worker
    }
  },
  crossOriginEmbedderPolicy: false    // needed for PDF blob viewer
}));

// Trust exactly one proxy hop when TRUST_PROXY is set (e.g. behind nginx).
// Without this env var we fall back to the real socket address so clients
// cannot spoof their IP via X-Forwarded-For to bypass rate limits or poison
// the audit log.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Rate-limit key: real socket IP regardless of proxy headers unless TRUST_PROXY is set
const rlKeyGenerator = process.env.TRUST_PROXY === '1'
  ? undefined  // use express-rate-limit default (respects trust proxy)
  : (req) => req.socket.remoteAddress || 'unknown';

/* Global rate limit — per-route limits are stricter */
app.use('/api', rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rlKeyGenerator,
}));

// Prevent browsers caching JS/CSS so code changes are always picked up
app.use((req, res, next) => {
  if (/\.(js|css)$/.test(req.path)) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

/* Serve PDF.js from node_modules (no CDN) */
app.use('/js/pdfjs', express.static(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build')));

app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: false,   // we handle routing manually
  etag:  true,
  maxAge: '1h',
}));

/* ── API Routes ─────────────────────────────────────────────────────────── */
app.use('/api/auth',     authRoutes);
app.use('/api/documents',docRoutes);
app.use('/api/tags',     tagRouter);
app.use('/api/types',    typeRouter);
app.use('/api/settings',       settingsRoutes);
app.use('/api/ai',             aiRoutes);
app.use('/api/correspondents', correspondentRoutes);

/* Signing — stricter limit for public token endpoints (anti-brute-force) */
app.use('/api/signing/public', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rlKeyGenerator,
  message: { error: 'Too many requests. Please try again later.' },
}));
app.use('/api/signing', signingRoutes);

/* MCP Server — separate rate limit (less aggressive for AI clients) */
app.use('/api/mcp', rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rlKeyGenerator,
  message: { error: 'Too many MCP requests, please slow down.' },
}));
app.use('/api/mcp', mcpRoutes);

/* OAuth well-known metadata — must be at root for RFC 8414 compliance */
app.get('/.well-known/oauth-authorization-server', oauthMeta);

/* ── SPA fallback — serve the shell for non-API routes ──────────────────── */
app.get('*', (req, res) => {
  let file = 'index.html';
  if (req.path === '/login')        file = 'login.html';
  else if (req.path === '/signing') file = 'signing.html';
  else if (req.path === '/sign')    file = 'sign.html';
  else if (req.path === '/verify')  file = 'verify.html';
  res.sendFile(path.join(__dirname, '..', 'public', file));
});

/* ── Global error handler ────────────────────────────────────────────────── */
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large')
    return res.status(413).json({ error: 'Request body too large.' });  if (err.type === 'entity.parse.failed' || err.status === 400)
    return res.status(400).json({ error: 'Invalid request body.' });  console.error('[error]', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

/* ── Start ───────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n  ✦ DocumentNeo running at  http://localhost:${PORT}`);
  console.log(`  ✦ Environment: ${process.env.NODE_ENV || 'development'}\n`);
  startWatcher();
});
