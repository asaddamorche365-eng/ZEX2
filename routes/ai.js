// routes/ai.js
//
// POST /api/generate-reply — the single, unified reply-generation
// endpoint. Replaces content.js's client-side generateReplyWithFallback
// + the 3 supporting Firebase-touching helpers that used to run in the
// browser: syncAdminApiKey, checkAndIncrementReplyCount, trackActivity.
//
// The extension sends { email, tweetText, tone, style, engineType,
// isBigMode, prevReplies, bigReplyWords, customPrompt, customWords,
// useGrammar, useProjectName } and gets back { text }. All provider API
// keys are looked up server-side from Firebase and never returned to
// the client.

const express = require('express');
const router = express.Router();
const { fbGet, fbUpdate, emailToKey } = require('../services/firebase');
const { generateReplyWithFallback, generateRepReplyWithFallback, generateFeedReplyWithFallback } = require('../services/aiProviders');
const { requireActiveUser } = require('../middleware/auth');

// Ported from content.js syncAdminApiKey — if an admin has assigned a
// specific provider/key to this user, that's the one they must use
// (mirrors the old "admin override clears all other local keys" logic,
// just resolved server-side now instead of synced into chrome.storage).
function resolveApiKeys(userData) {
  const apiKeyMap = {
    'DEEPSEEK': 'deepseekApiKey', 'GROQ': 'groqApiKey',
    'GEMINI 2.0': 'geminiApiKey', 'GEMINI 1.5': 'geminiApiKey',
    'OPENROUTER': 'openrouterApiKey', 'OPENAI GPT': 'openaiApiKey',
  };

  const adminKey = userData.adminApiKey || userData.deepseekApiKey || userData.groqApiKey ||
                   userData.geminiApiKey || userData.openrouterApiKey || userData.openaiApiKey;
  const adminType = userData.adminApiType;

  if (adminType && adminKey) {
    const keys = { geminiApiKey: '', openrouterApiKey: '', openaiApiKey: '', deepseekApiKey: '', groqApiKey: '' };
    const field = apiKeyMap[adminType];
    if (field) keys[field] = adminKey;
    return keys;
  }

  return {
    geminiApiKey: userData.geminiApiKey || '',
    openrouterApiKey: userData.openrouterApiKey || '',
    openaiApiKey: userData.openaiApiKey || '',
    deepseekApiKey: userData.deepseekApiKey || '',
    groqApiKey: userData.groqApiKey || '',
  };
}

// Ported from content.js checkAndIncrementReplyCount.
async function checkAndIncrementReplyCount(uKey, userData) {
  const limit = userData.replyLimit || 0;
  const used = userData.replyCount || 0;
  if (limit > 0 && used >= limit) {
    return { allowed: false, reason: `Limit reached (${used}/${limit})` };
  }
  await fbUpdate(`users/${uKey}`, { replyCount: used + 1 });
  return { allowed: true };
}

// Ported from content.js trackActivity.
async function trackActivity(uKey) {
  await fbUpdate(`users/${uKey}`, { lastActive: Date.now() });
}

router.post('/generate-reply', requireActiveUser, async (req, res) => {
  const { uKey, data: userData } = req.zexUser;

  try {
    const {
      tweetText, tone, style, engineType,
      smartSwitch, useGrammar, useProjectName,
      prevReplies, bigReplyWords, customPrompt, customWords,
    } = req.body || {};

    if (!tweetText || !tone) {
      return res.status(400).json({ error: 'tweetText and tone are required.' });
    }

    const keys = resolveApiKeys(userData);
    const hasAnyKey = keys.geminiApiKey || keys.openrouterApiKey || keys.openaiApiKey || keys.deepseekApiKey || keys.groqApiKey;
    if (!hasAnyKey) {
      return res.status(400).json({ error: 'No API key configured for this account. Add one in the Z EX popup or contact admin.' });
    }

    const limitCheck = await checkAndIncrementReplyCount(uKey, userData);
    if (!limitCheck.allowed) {
      return res.status(429).json({ error: limitCheck.reason });
    }

    trackActivity(uKey).catch(() => {}); // fire-and-forget, matches old behavior

    let text;
    try {
      text = await generateReplyWithFallback({
        tweetText, tone, style: style || '',
        geminiKey: keys.geminiApiKey,
        openrouterKey: keys.openrouterApiKey,
        openaiKey: keys.openaiApiKey,
        deepseekKey: keys.deepseekApiKey,
        groqKey: keys.groqApiKey,
        smartSwitch: smartSwitch !== false,
        useGrammar: useGrammar !== false,
        useProjectName: useProjectName !== false,
        prevReplies: Array.isArray(prevReplies) ? prevReplies : [],
        bigReplyWords: bigReplyWords || null,
        customPrompt: tone === 'Custom' ? (customPrompt || '') : null,
        customWords: tone === 'Custom' ? (customWords || '') : null,
        // onStep intentionally omitted — the sci-fi process-panel typing
        // effect in content.js is purely a client-side UI animation; it
        // doesn't need to be driven by real server progress events for
        // this migration (the panel can just show a couple of fixed
        // steps client-side while waiting for the response).
      });
    } catch (genErr) {
      // Reverse the increment since we didn't actually generate,
      // mirroring the old client-side rollback-on-no-key/failure path.
      await fbUpdate(`users/${uKey}`, { replyCount: Math.max(0, (userData.replyCount || 1)) });
      return res.status(502).json({ error: genErr.message || 'All APIs failed. Check keys.' });
    }

    res.json({ text, engineType: engineType || null });
  } catch (e) {
    res.status(500).json({ error: 'Reply generation failed: ' + e.message });
  }
});

// ── POST /api/generate-rep-reply ───────────────────────────────────
// Replaces content.js's repHandleClick's local syncAdminApiKey/
// checkAndIncrementReplyCount/trackActivity + repGenerateReplyWithFallback
// call. This is the REP engine's one-click comment-reply quick mode —
// shorter prompt, no tone/style/dedup, separate from the main
// /api/generate-reply used by handleGetReply.
router.post('/generate-rep-reply', requireActiveUser, async (req, res) => {
  const { uKey, data: userData } = req.zexUser;
  try {
    const { postText, commentText, smartSwitch } = req.body || {};
    if (!postText || !commentText) {
      return res.status(400).json({ error: 'postText and commentText are required.' });
    }

    const keys = resolveApiKeys(userData);
    const hasAnyKey = keys.geminiApiKey || keys.openrouterApiKey || keys.openaiApiKey || keys.deepseekApiKey || keys.groqApiKey;
    if (!hasAnyKey) {
      return res.status(400).json({ error: 'No API key configured for this account. Add one in the Z EX popup or contact admin.' });
    }

    const limitCheck = await checkAndIncrementReplyCount(uKey, userData);
    if (!limitCheck.allowed) {
      return res.status(429).json({ error: limitCheck.reason });
    }

    trackActivity(uKey).catch(() => {});

    let text;
    try {
      text = await generateRepReplyWithFallback({
        postText, commentText,
        geminiKey: keys.geminiApiKey,
        openrouterKey: keys.openrouterApiKey,
        openaiKey: keys.openaiApiKey,
        deepseekKey: keys.deepseekApiKey,
        groqKey: keys.groqApiKey,
        smartSwitch: smartSwitch !== false,
      });
    } catch (genErr) {
      await fbUpdate(`users/${uKey}`, { replyCount: Math.max(0, (userData.replyCount || 1)) });
      return res.status(502).json({ error: genErr.message || 'All APIs failed. Check keys.' });
    }

    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: 'Reply generation failed: ' + e.message });
  }
});

// ── POST /api/generate-feed-reply ──────────────────────────────────
// Replaces content.js's feedHandleClickModel1's equivalent block +
// feedGenerateReplyWithFallback call. FED engine's "Model 1" quick
// feed-reply mode — same shape as generate-rep-reply, no commentText.
router.post('/generate-feed-reply', requireActiveUser, async (req, res) => {
  const { uKey, data: userData } = req.zexUser;
  try {
    const { postText, smartSwitch } = req.body || {};
    if (!postText) {
      return res.status(400).json({ error: 'postText is required.' });
    }

    const keys = resolveApiKeys(userData);
    const hasAnyKey = keys.geminiApiKey || keys.openrouterApiKey || keys.openaiApiKey || keys.deepseekApiKey || keys.groqApiKey;
    if (!hasAnyKey) {
      return res.status(400).json({ error: 'No API key configured for this account. Add one in the Z EX popup or contact admin.' });
    }

    const limitCheck = await checkAndIncrementReplyCount(uKey, userData);
    if (!limitCheck.allowed) {
      return res.status(429).json({ error: limitCheck.reason });
    }

    trackActivity(uKey).catch(() => {});

    let text;
    try {
      text = await generateFeedReplyWithFallback({
        postText,
        geminiKey: keys.geminiApiKey,
        openrouterKey: keys.openrouterApiKey,
        openaiKey: keys.openaiApiKey,
        deepseekKey: keys.deepseekApiKey,
        groqKey: keys.groqApiKey,
        smartSwitch: smartSwitch !== false,
      });
    } catch (genErr) {
      await fbUpdate(`users/${uKey}`, { replyCount: Math.max(0, (userData.replyCount || 1)) });
      return res.status(502).json({ error: genErr.message || 'All APIs failed. Check keys.' });
    }

    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: 'Reply generation failed: ' + e.message });
  }
});

module.exports = router;
