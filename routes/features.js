// routes/features.js
//
// Replaces the extension's applyFeatureFlags() calling fbGet directly.
// Same resolution rule as before: default enabled, only explicit
// `false` disables a feature. The DOM show/hide/banner logic in
// popup.js is unchanged — only the data source moves from a raw
// Firebase fetch to this endpoint.

const express = require('express');
const router = express.Router();
const { fbGet, fbUpdate, emailToKey } = require('../services/firebase');
const { requireAdminSecret } = require('../middleware/auth');

// Keep in sync with FEATURE_SECTIONS keys in popup.js. `follow` is the
// newer Follow Engine flag folded into this migration per the brief.
const KNOWN_FEATURES = [
  'projectName', 'smartSwitch', 'bigReply', 'replyStyle',
  'keyword', 'customTone', 'tone', 'grammar', 'sk1', 'follow',
];

function resolveFlags(rawFlags) {
  const resolved = {};
  for (const key of KNOWN_FEATURES) {
    resolved[key] = !rawFlags || rawFlags[key] !== false;
  }
  return resolved;
}

// GET /api/features/:userKey
// userKey is the emailToKey-derived string, kept for continuity with the
// extension's existing local derivation (so no extra round trip needed
// to turn an email into a key on the client).
router.get('/:userKey', async (req, res) => {
  try {
    const { userKey } = req.params;
    const rawFlags = await fbGet(`users/${userKey}/features`);
    res.json(resolveFlags(rawFlags));
  } catch (e) {
    res.status(500).json({ error: 'Failed to load features: ' + e.message });
  }
});

// PATCH /api/admin/features/:userKey  (admin-only — flip one or more flags)
// Body: { features: { smartSwitch: false, follow: true, ... } }
router.patch('/admin/:userKey', requireAdminSecret, async (req, res) => {
  try {
    const { userKey } = req.params;
    const { features } = req.body || {};
    if (!features || typeof features !== 'object') {
      return res.status(400).json({ error: 'Body must include a "features" object.' });
    }
    const invalidKeys = Object.keys(features).filter(k => !KNOWN_FEATURES.includes(k));
    if (invalidKeys.length) {
      return res.status(400).json({ error: 'Unknown feature key(s): ' + invalidKeys.join(', ') });
    }
    await fbUpdate(`users/${userKey}/features`, features);
    const rawFlags = await fbGet(`users/${userKey}/features`);
    res.json({ ok: true, features: resolveFlags(rawFlags) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update features: ' + e.message });
  }
});

module.exports = router;
module.exports.resolveFlags = resolveFlags;
module.exports.KNOWN_FEATURES = KNOWN_FEATURES;
