// routes/admin.js
//
// First-pass admin control surface, protected by a shared secret
// (env var ADMIN_SECRET) per the migration brief. Replaces "open the
// Firebase console and hand-edit JSON" with authenticated REST calls.
// A proper admin UI with its own login is a follow-up — these routes
// are structured so a future UI (or this same secret via a simple
// fetch-based page) can call them directly.

const express = require('express');
const router = express.Router();
const { fbGet, fbUpdate, fbSet, fbDelete, emailToKey } = require('../services/firebase');
const { requireAdminSecret } = require('../middleware/auth');
const { resolveFlags, KNOWN_FEATURES } = require('./features');

router.use(requireAdminSecret);

// ── GET /api/admin/users ────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const users = await fbGet('users');
    res.json(users || {});
  } catch (e) {
    res.status(500).json({ error: 'Failed to list users: ' + e.message });
  }
});

// ── GET /api/admin/users/:userKey ───────────────────────────────
router.get('/users/:userKey', async (req, res) => {
  try {
    const user = await fbGet(`users/${req.params.userKey}`);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch user: ' + e.message });
  }
});

// ── PATCH /api/admin/users/:userKey ─────────────────────────────
// General-purpose field updates: expiresAt, active, replyLimit,
// autoLogoutMinutes, apiLocked, adminApiType, adminApiKey,
// xVerifyMuted, notice, etc. — anything previously hand-edited in the
// Firebase console under users/{uKey}.
router.patch('/users/:userKey', async (req, res) => {
  try {
    const updates = req.body || {};
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No fields provided to update.' });
    }
    await fbUpdate(`users/${req.params.userKey}`, updates);
    const user = await fbGet(`users/${req.params.userKey}`);
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update user: ' + e.message });
  }
});

// ── PATCH /api/admin/users/:userKey/features ────────────────────
router.patch('/users/:userKey/features', async (req, res) => {
  try {
    const { features } = req.body || {};
    if (!features || typeof features !== 'object') {
      return res.status(400).json({ error: 'Body must include a "features" object.' });
    }
    const invalidKeys = Object.keys(features).filter(k => !KNOWN_FEATURES.includes(k));
    if (invalidKeys.length) {
      return res.status(400).json({ error: 'Unknown feature key(s): ' + invalidKeys.join(', ') });
    }
    await fbUpdate(`users/${req.params.userKey}/features`, features);
    const rawFlags = await fbGet(`users/${req.params.userKey}/features`);
    res.json({ ok: true, features: resolveFlags(rawFlags) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update features: ' + e.message });
  }
});

// ── DELETE /api/admin/users/:userKey ────────────────────────────
router.delete('/users/:userKey', async (req, res) => {
  try {
    await fbDelete(`users/${req.params.userKey}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete user: ' + e.message });
  }
});

// ── GET /api/admin/registration-requests ────────────────────────
router.get('/registration-requests', async (req, res) => {
  try {
    const requests = await fbGet('registrationRequests');
    res.json(requests || {});
  } catch (e) {
    res.status(500).json({ error: 'Failed to list registration requests: ' + e.message });
  }
});

// ── POST /api/admin/registration-requests/:userKey/approve ──────
// Creates the user record and (optionally) issues an invite code, then
// marks the request approved. Mirrors what an admin previously did by
// hand in the Firebase console: create users/{uKey} + set request status.
router.post('/registration-requests/:userKey/approve', async (req, res) => {
  try {
    const { userKey } = req.params;
    const { expiresInDays, inviteCode, inviteCodeExpiresInMinutes } = req.body || {};

    const reqData = await fbGet(`registrationRequests/${userKey}`);
    if (!reqData) return res.status(404).json({ error: 'Registration request not found.' });

    const now = Date.now();
    const expiresAt = now + (Number(expiresInDays) || 30) * 86400000;

    await fbSet(`users/${userKey}`, {
      email: reqData.email,
      password: reqData.password,
      active: true,
      expiresAt,
      createdAt: now,
    });

    const updates = { status: 'approved', approvedAt: now };
    if (inviteCode) {
      updates.inviteCode = inviteCode;
      updates.inviteCodeExpiresAt = now + (Number(inviteCodeExpiresInMinutes) || 60) * 60000;
      updates.inviteCodeUsed = false;
    }
    await fbUpdate(`registrationRequests/${userKey}`, updates);

    res.json({ ok: true, expiresAt });
  } catch (e) {
    res.status(500).json({ error: 'Failed to approve registration: ' + e.message });
  }
});

// ── POST /api/admin/registration-requests/:userKey/reject ───────
router.post('/registration-requests/:userKey/reject', async (req, res) => {
  try {
    const { reason } = req.body || {};
    await fbUpdate(`registrationRequests/${req.params.userKey}`, {
      status: 'rejected', rejectReason: reason || '', rejectedAt: Date.now(),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reject registration: ' + e.message });
  }
});
// ── GET /api/admin/code-requests ────────────────────────────────
router.get('/code-requests', async (req, res) => {
  try {
    const requests = await fbGet('codeRequests');
    res.json(requests || {});
  } catch (e) {
    res.status(500).json({ error: 'Failed to list code requests: ' + e.message });
  }
});

// ── POST /api/admin/code-requests/:userKey/send ──────────────────
// Generates and sends a fresh unique code in response to a pending
// code request (was: admin hand-writing codes/{code} + codeRequests/{uKey}).
router.post('/code-requests/:userKey/send', async (req, res) => {
  try {
    const { userKey } = req.params;
    const { code: providedCode, durationDays, expiresInMinutes, assignedEmail } = req.body || {};

    const code = (providedCode || generateCode()).toUpperCase();
    const now = Date.now();
    const codeExpiresAt = now + (Number(expiresInMinutes) || 60) * 60000;

    await fbSet(`codes/${code}`, {
      createdAt: now,
      codeExpiresAt,
      durationDays: Number(durationDays) || 30,
      used: false,
      assignedEmail: assignedEmail || null,
    });

    await fbUpdate(`codeRequests/${userKey}`, {
      status: 'sent', code, codeExpiresAt, sentAt: now,
    });

    res.json({ ok: true, code, codeExpiresAt });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send code: ' + e.message });
  }
});

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── POST /api/admin/codes ───────────────────────────────────────
// Direct code creation (not tied to a code request) — e.g. for selling
// fresh activation codes.
router.post('/codes', async (req, res) => {
  try {
    const { code: providedCode, durationDays, expiresInMinutes, assignedEmail } = req.body || {};
    const code = (providedCode || generateCode()).toUpperCase();
    const now = Date.now();
    const codeExpiresAt = now + (Number(expiresInMinutes) || 1440) * 60000;

    await fbSet(`codes/${code}`, {
      createdAt: now,
      codeExpiresAt,
      durationDays: Number(durationDays) || 30,
      used: false,
      assignedEmail: assignedEmail || null,
    });

    res.json({ ok: true, code, codeExpiresAt });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create code: ' + e.message });
  }
});

// ── GET /api/admin/codes ────────────────────────────────────────
router.get('/codes', async (req, res) => {
  try {
    const codes = await fbGet('codes');
    res.json(codes || {});
  } catch (e) {
    res.status(500).json({ error: 'Failed to list codes: ' + e.message });
  }
});

// ── PATCH /api/admin/contact-settings ───────────────────────────
router.patch('/contact-settings', async (req, res) => {
  try {
    const { xUsername, tgUsername } = req.body || {};
    const updates = {};
    if (xUsername) updates.xUsername = xUsername;
    if (tgUsername) updates.tgUsername = tgUsername;
    await fbUpdate('contactSettings', updates);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update contact settings: ' + e.message });
  }
});

// ── POST /api/admin/notices/global ──────────────────────────────
router.post('/notices/global', async (req, res) => {
  try {
    const { msg } = req.body || {};
    if (!msg) return res.status(400).json({ error: 'msg is required' });
    const notice = { id: 'ntc_' + Date.now(), msg, sentAt: Date.now() };
    await fbSet('globalNotice', notice);
    await fbUpdate(`noticeHistory/${notice.id}`, notice);
    res.json({ ok: true, notice });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send global notice: ' + e.message });
  }
});

// ── POST /api/admin/notices/user/:userKey ───────────────────────
router.post('/notices/user/:userKey', async (req, res) => {
  try {
    const { msg } = req.body || {};
    if (!msg) return res.status(400).json({ error: 'msg is required' });
    const notice = { id: 'ntc_' + Date.now(), msg, sentAt: Date.now() };
    await fbUpdate(`users/${req.params.userKey}`, { notice });
    res.json({ ok: true, notice });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send user notice: ' + e.message });
  }
});

// ── POST /api/admin/users/:userKey/unmute-x ─────────────────────
router.post('/users/:userKey/unmute-x', async (req, res) => {
  try {
    await fbUpdate(`users/${req.params.userKey}`, { xVerifyMuted: false, xVerifyMuteUntil: null });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to unmute: ' + e.message });
  }
});

module.exports = router;
