// routes/follow.js
//
// OPTIONAL per the migration brief: the click/navigate/queue loop for
// the Follow Engine stays entirely in background.js (browser-bound
// automation, out of scope for a server). This route only lets the
// gap-range policy (minGapMs/maxGapMs between follows) be centrally
// controlled from Firebase instead of the hardcoded FOLLOW_SPEED_PRESETS
// object in popup.js, if you choose to wire it up. background.js's own
// gap-rolling logic (`minGapMs + Math.random() * (maxGapMs - minGapMs)`)
// is unchanged either way — this just supplies the two numbers.

const express = require('express');
const router = express.Router();
const { fbGet } = require('../services/firebase');

const DEFAULT_PRESETS = {
  safe: { min: 120000, max: 240000 },
  normal: { min: 45000, max: 90000 },
};

// GET /api/follow/next-gap?userKey=...&preset=safe|normal
// Falls back to the extension's existing hardcoded presets if nothing
// is configured centrally, so this endpoint is safe to leave unused.
router.get('/next-gap', async (req, res) => {
  try {
    const { userKey, preset } = req.query;
    let overrides = null;
    if (userKey) {
      overrides = await fbGet(`users/${userKey}/followGapOverrides`);
    }
    const key = preset === 'normal' ? 'normal' : 'safe';
    const range = (overrides && overrides[key]) || DEFAULT_PRESETS[key];
    res.json({ minGapMs: range.min, maxGapMs: range.max });
  } catch (e) {
    res.status(500).json({ error: 'Failed to resolve follow gap: ' + e.message });
  }
});

module.exports = router;
