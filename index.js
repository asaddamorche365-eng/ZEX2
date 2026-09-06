// index.js — Express app entry point.
//
// Mounts every route module and adds the two pieces of middleware that
// matter for this migration: CORS restricted to the extension's own
// origin(s) via ALLOWED_ORIGINS, and JSON body parsing. No Firebase
// client SDK, no RTDB URL, no provider API keys ever ship in this
// server's responses to the extension except the resolved AI reply
// text itself.

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const featuresRoutes = require('./routes/features');
const aiRoutes = require('./routes/ai');
const adminRoutes = require('./routes/admin');
const followRoutes = require('./routes/follow');

const app = express();

// ── CORS ──────────────────────────────────────────────────────────
// Chrome/Kiwi extensions send requests with an Origin header like
// `chrome-extension://<extension-id>`. Put that exact origin string in
// ALLOWED_ORIGINS (comma-separated) once the extension is loaded/packed,
// since the ID is stable per-extension-key but not knowable in advance
// here. During development, leaving ALLOWED_ORIGINS unset allows all
// origins so you're not blocked while wiring things up — lock it down
// before shipping.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-zex-email', 'x-admin-secret'],
}));

app.use(express.json({ limit: '1mb' }));

// ── Health check ─────────────────────────────────────────────────
// Railway/Render both expect a fast-responding root or /health path
// for their health checks.
app.get('/', (req, res) => res.json({ ok: true, service: 'zex-server' }));
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Routes ────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/features', featuresRoutes);
app.use('/api', aiRoutes); // exposes POST /api/generate-reply
app.use('/api/admin', adminRoutes);
app.use('/api/follow', followRoutes);

// The features admin-patch route also lives inside routes/features.js
// under /admin/:userKey — mount it there too for convenience alongside
// the general admin router.
app.use('/api/features', featuresRoutes);

// ── 404 + error handling ────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`zex-server listening on port ${PORT}`);
});
