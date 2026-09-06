// routes/auth.js
//
// Replaces every direct-Firebase auth/session/registration/activation
// call the extension used to make from popup.js. Business logic and
// validation rules are ported as-is (same messages, same status
// semantics) — only the transport changes from raw REST fetches to
// this server's endpoints using the Firebase Admin SDK.
//
// NOTE ON DEVICE LOCKING: the extension derives a device fingerprint
// client-side (getDeviceLockId()) since it depends on navigator.*/
// screen.* which only exist in the browser. That derivation stays in
// the extension; the server just receives deviceId/uid/deviceInfo as
// opaque strings/objects and stores/compares them exactly as Firebase
// did before.

const express = require('express');
const router = express.Router();
const { fbGet, fbUpdate, fbSet, fbPush, emailToKey } = require('../services/firebase');
const { requireAdminSecret } = require('../middleware/auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── POST /api/auth/login ──────────────────────────────────────────
// Body: { email, password, deviceId, uid, uniqueCode?, isDeviceLocked, deviceInfo }
// Mirrors handleLogin()'s two branches: first-login-with-unique-code,
// and normal already-locked-device login.
router.post('/login', async (req, res) => {
  try {
    const { email: rawEmail, password, deviceId, uid, uniqueCode, isDeviceLocked, deviceInfo } = req.body || {};
    const email = (rawEmail || '').trim().toLowerCase();
    const pw = (password || '').trim();

    if (!email || !pw) return res.status(400).json({ error: 'Enter your Gmail and Password' });
    if (!deviceId) return res.status(400).json({ error: 'Missing device identification.' });

    const uKey = emailToKey(email);

    if (!isDeviceLocked) {
      // First login on this device — requires a valid unique code.
      const code = (uniqueCode || '').trim().toUpperCase();
      if (!code) return res.status(400).json({ error: 'First login — enter your Unique Code', needsCode: true });

      const codeData = await fbGet(`codes/${code}`);
      if (!codeData) return res.status(400).json({ error: 'Invalid Unique Code!' });
      if (codeData.used) return res.status(400).json({ error: 'This code has already been used!' });
      if (codeData.assignedEmail && codeData.assignedEmail !== email) {
        return res.status(400).json({ error: 'This code is not for this email!' });
      }
      if (Date.now() > codeData.codeExpiresAt) return res.status(400).json({ error: 'Code has expired!' });

      const userData = await fbGet(`users/${uKey}`);
      if (!userData) return res.status(404).json({ error: 'User not found.' });
      if (!userData.active) return res.status(403).json({ error: 'Account disabled।' });
      if (userData.password !== pw) return res.status(401).json({ error: 'Incorrect password.' });
      if (Date.now() >= userData.expiresAt) return res.status(403).json({ error: 'Subscription has ended.' });

      const now = Date.now();

      const usageLog = (await fbGet(`codeUsageLog/${uKey}`)) || {};
      const useCount = (usageLog.count || 0) + 1;
      const usageHistory = usageLog.history || [];
      usageHistory.push({ code, usedAt: now, uid, deviceInfo });
      await fbUpdate(`codeUsageLog/${uKey}`, { email, count: useCount, lastUsedAt: now, lastCode: code, history: usageHistory });

      await fbUpdate(`codes/${code}`, { used: true, usedAt: now, uid, usedBy: email, deviceInfo });
      await fbUpdate(`users/${uKey}`, { uid, lastLogin: now });
      await fbUpdate(`uidAccounts/${uid}`, { email, firstLoginAt: now, deviceInfo });
      await fbUpdate(`registrationRequests/${uKey}`, { status: 'used', clearedAt: now, inviteCode: null, inviteCodeExpiresAt: null, inviteCodeUsed: null });

      const existingCodeReq = await fbGet(`codeRequests/${uKey}`);
      await fbUpdate(`codeRequests/${uKey}`, { status: 'used', usedAt: now, useCount: (existingCodeReq && existingCodeReq.useCount) || 1 });

      return res.json({
        ok: true,
        deviceLockKey: deviceId + '_' + uKey,
        session: {
          email, loginTime: now, expiresAt: userData.expiresAt, deviceId, uid,
          xHandle: userData.x || '', tgHandle: userData.tg || '',
        },
        needsXVerify: !userData.xVerified,
      });
    }

    // Already-locked-device login (no code needed).
    const userData = await fbGet(`users/${uKey}`);
    if (!userData) return res.status(404).json({ error: 'User not found.' });
    if (!userData.active) return res.status(403).json({ error: 'Account disabled।' });
    if (userData.password !== pw) return res.status(401).json({ error: 'Incorrect password.' });
    if (Date.now() >= userData.expiresAt) return res.status(403).json({ error: 'Subscription has ended.' });
    if (userData.deviceId && userData.deviceId !== deviceId) {
      return res.status(403).json({ error: 'This account is not registered on this device.' });
    }

    const now = Date.now();
    await fbUpdate(`users/${uKey}`, { lastLogin: now });

    res.json({
      ok: true,
      session: {
        email, loginTime: now, expiresAt: userData.expiresAt, deviceId,
        xHandle: userData.x || '', tgHandle: userData.tg || '',
      },
      needsXVerify: false, // legacy already-locked path never gated dashboard on X verify
    });
  } catch (e) {
    res.status(500).json({ error: 'Login failed: ' + e.message });
  }
});

// ── POST /api/auth/session-refresh ────────────────────────────────
// Polled every 5 min by the extension (was startTimer's serverCheckInterval)
// and on popup open. Re-validates active/expiresAt/autoLogoutMinutes.
router.post('/session-refresh', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const uKey = emailToKey(email);
    const userData = await fbGet(`users/${uKey}`);
    if (!userData || !userData.active) {
      return res.status(403).json({ ok: false, error: 'Account inactive or not found.' });
    }
    res.json({
      ok: true,
      expiresAt: userData.expiresAt,
      autoLogoutMinutes: typeof userData.autoLogoutMinutes === 'number' ? userData.autoLogoutMinutes : 60,
      xVerified: !!userData.xVerified,
    });
  } catch (e) {
    res.status(500).json({ error: 'Session refresh failed: ' + e.message });
  }
});

// ── POST /api/auth/activate ───────────────────────────────────────
// Extends an existing account's expiry with a fresh code (handleActivation).
router.post('/activate', async (req, res) => {
  try {
    const { email, code: rawCode } = req.body || {};
    const code = (rawCode || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Enter the extension code' });
    if (!email) return res.status(400).json({ error: 'Please log in first, then extend' });

    const codeData = await fbGet(`codes/${code}`);
    if (!codeData) return res.status(400).json({ error: 'Invalid code!' });
    if (codeData.used) return res.status(400).json({ error: 'This code has already been used!' });
    if (Date.now() > codeData.codeExpiresAt) return res.status(400).json({ error: 'Code has expired!' });
    if (codeData.assignedEmail && codeData.assignedEmail !== email) {
      return res.status(400).json({ error: 'This code is not for your account!' });
    }

    const uKey = emailToKey(email);
    const existing = await fbGet(`users/${uKey}`);
    if (!existing) return res.status(404).json({ error: 'User data not found.' });

    const now = Date.now();
    const durationMs = (codeData.durationDays || 30) * 86400000;
    const newExpiry = Math.max(existing.expiresAt, now) + durationMs;

    await fbUpdate(`users/${uKey}`, { expiresAt: newExpiry, active: true });
    await fbUpdate(`codes/${code}`, { used: true, usedAt: now, usedBy: email });

    res.json({ ok: true, expiresAt: newExpiry, durationDays: codeData.durationDays || 30 });
  } catch (e) {
    res.status(500).json({ error: 'Activation failed: ' + e.message });
  }
});

// ── POST /api/auth/register ───────────────────────────────────────
// Submits a registration request for admin approval (handleRegisterRequest).
router.post('/register', async (req, res) => {
  try {
    const { email: rawEmail, password, uid, deviceInfo } = req.body || {};
    const email = (rawEmail || '').trim().toLowerCase();
    const pw = (password || '').trim();

    if (!email) return res.status(400).json({ error: 'Enter your Gmail address' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (!pw) return res.status(400).json({ error: 'Set a password' });
    if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const uKey = emailToKey(email);

    const existingUser = await fbGet(`users/${uKey}`);
    if (existingUser) return res.status(409).json({ error: 'An account already exists with this email — please log in' });

    const existingReq = await fbGet(`registrationRequests/${uKey}`);
    if (existingReq && existingReq.status === 'pending') {
      return res.json({ ok: true, status: 'pending', reqData: existingReq });
    }
    if (existingReq && existingReq.status === 'rejected') {
      return res.json({ ok: true, status: 'rejected', reason: existingReq.rejectReason || '', reqData: existingReq });
    }

    const now = Date.now();
    await fbUpdate(`uidAccounts/${uid}`, { email, registeredAt: now, deviceInfo });
    await fbUpdate(`registrationRequests/${uKey}`, {
      email, password: pw, requestedAt: now, status: 'pending', deviceInfo: uid,
    });

    res.json({ ok: true, status: 'pending' });
  } catch (e) {
    res.status(500).json({ error: 'Registration failed: ' + e.message });
  }
});

// ── GET /api/auth/registration-status ─────────────────────────────
// Powers both the poll loop (startRegPoll) and restore-on-reopen
// (tryRestoreRegByEmail / restore pending state).
router.get('/registration-status', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });
    const uKey = emailToKey(String(email).trim().toLowerCase());

    const req_ = await fbGet(`registrationRequests/${uKey}`);
    if (!req_) {
      const user = await fbGet(`users/${uKey}`);
      if (user && user.active) return res.json({ status: 'approved', reqData: null });
      return res.json({ status: 'none' });
    }
    res.json({ status: req_.status, reqData: req_, reason: req_.rejectReason || '' });
  } catch (e) {
    res.status(500).json({ error: 'Status check failed: ' + e.message });
  }
});

// ── POST /api/auth/request-code ───────────────────────────────────
// Existing user asking admin for a new unique code (handleRequestCode).
router.post('/request-code', async (req, res) => {
  try {
    const { email: rawEmail, deviceId, deviceInfo } = req.body || {};
    const email = (rawEmail || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'First enter your Gmail and tap LOGIN, then send the request.' });

    const uKey = emailToKey(email);
    const userData = await fbGet(`users/${uKey}`);
    if (!userData) return res.status(404).json({ error: 'No account exists with this email.' });
    if (!userData.active) return res.status(403).json({ error: 'Account disabled।' });

    const existing = await fbGet(`codeRequests/${uKey}`);
    if (existing && existing.status === 'pending') {
      return res.json({ ok: true, status: 'pending' });
    }
    if (existing && existing.status === 'sent' && existing.code && existing.codeExpiresAt && Date.now() < existing.codeExpiresAt) {
      return res.json({ ok: true, status: 'sent', code: existing.code, codeExpiresAt: existing.codeExpiresAt });
    }

    await fbUpdate(`codeRequests/${uKey}`, {
      email, status: 'pending', requestedAt: Date.now(),
      deviceId, deviceInfo, useCount: (existing && existing.useCount) || 0,
    });

    res.json({ ok: true, status: 'pending' });
  } catch (e) {
    res.status(500).json({ error: 'Code request failed: ' + e.message });
  }
});

// ── GET /api/auth/code-request-status ─────────────────────────────
// Powers startCodeReqPoll / restoreCodeReqState.
router.get('/code-request-status', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });
    const uKey = emailToKey(String(email).trim().toLowerCase());
    const reqData = await fbGet(`codeRequests/${uKey}`);
    if (!reqData) return res.json({ status: 'none' });
    res.json({ status: reqData.status, code: reqData.code || null, codeExpiresAt: reqData.codeExpiresAt || null });
  } catch (e) {
    res.status(500).json({ error: 'Code request status check failed: ' + e.message });
  }
});

// ── POST /api/auth/verify-x ────────────────────────────────────────
// The actual "open x.com/<user> and check for Edit Profile button" step
// MUST stay client-side (it's real browser tab automation — out of
// scope for a server to do). This endpoint only takes the client's
// already-determined isOwner result and applies the same Firebase
// writes/dup-detection/mute logic handleXVerify() used to do directly.
router.post('/verify-x', async (req, res) => {
  try {
    const { email, isOwner, enteredUsername: rawUsername, failCount: clientFailCount } = req.body || {};
    if (!email || !rawUsername) return res.status(400).json({ error: 'email and enteredUsername required' });
    const uKey = emailToKey(email);
    const enteredUsername = String(rawUsername).trim().replace(/^@/, '').toLowerCase();

    const fbUserData = await fbGet(`users/${uKey}`);
    if (fbUserData && fbUserData.xVerifyMuted === true && fbUserData.xVerifyMuteUntil && Date.now() < fbUserData.xVerifyMuteUntil) {
      const remaining = Math.ceil((fbUserData.xVerifyMuteUntil - Date.now()) / 60000);
      return res.status(429).json({ error: `Muted for ${remaining} more minutes. Admin has been notified.`, muted: true });
    }

    if (isOwner === true) {
      const allUsers = await fbGet('users');
      let dupWarning = null;
      if (allUsers) {
        const duplicate = Object.entries(allUsers).find(([k, u]) =>
          u.x && u.x.toLowerCase() === enteredUsername.toLowerCase() && k !== uKey
        );
        if (duplicate) dupWarning = { otherEmail: duplicate[1].email || duplicate[0], detectedAt: Date.now() };
      }
      await fbUpdate(`users/${uKey}`, {
        x: enteredUsername, xVerified: true, xVerifiedAt: Date.now(),
        xDuplicateWarning: dupWarning || null,
      });
      return res.json({ ok: true, verified: true, xHandle: enteredUsername, duplicateWarning: dupWarning });
    }

    // Not the owner — fake-account attempt.
    const failCount = (clientFailCount || 0) + 1;
    await fbUpdate(`users/${uKey}`, {
      xVerifyWarning: { attemptedUsername: enteredUsername, at: Date.now(), count: failCount, reason: 'follow_button_detected' },
    });

    const X_MAX_FAILS = 3;
    if (failCount >= X_MAX_FAILS) {
      const muteUntil = Date.now() + 24 * 60 * 60 * 1000;
      await fbUpdate(`users/${uKey}`, { xVerifyMuted: true, xVerifyMuteUntil: muteUntil });
      return res.json({ ok: true, verified: false, muted: true, muteUntil, failCount: 0 });
    }
    res.json({ ok: true, verified: false, muted: false, failCount, remaining: X_MAX_FAILS - failCount });
  } catch (e) {
    res.status(500).json({ error: 'X verification failed: ' + e.message });
  }
});

// ── POST /api/auth/verify-tg ───────────────────────────────────────
router.post('/verify-tg', async (req, res) => {
  try {
    const { email, handle: rawHandle } = req.body || {};
    if (!email || !rawHandle) return res.status(400).json({ error: 'email and handle required' });
    const handle = String(rawHandle).trim().replace(/^@/, '');
    const uKey = emailToKey(email);
    await fbUpdate(`users/${uKey}`, { tg: handle, tgVerified: true, tgVerifiedAt: Date.now() });
    res.json({ ok: true, tgHandle: handle });
  } catch (e) {
    res.status(500).json({ error: 'Telegram verification failed: ' + e.message });
  }
});

// ── GET /api/auth/notices ──────────────────────────────────────────
router.get('/notices', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });
    const uKey = emailToKey(String(email).trim().toLowerCase());

    const [userNotice, globalNotice, noticeHistory] = await Promise.all([
      fbGet(`users/${uKey}/notice`),
      fbGet('globalNotice'),
      fbGet('noticeHistory'),
    ]);

    const allNotices = [];
    if (noticeHistory) {
      Object.entries(noticeHistory)
        .sort((a, b) => b[1].sentAt - a[1].sentAt)
        .forEach(([, n]) => { if (n && n.msg) allNotices.push(n); });
    }
    if (globalNotice && globalNotice.msg && !allNotices.find(n => n.id === globalNotice.id)) {
      allNotices.unshift(globalNotice);
    }

    let activeNotice = null;
    if (userNotice && userNotice.msg) activeNotice = userNotice;
    else if (globalNotice && globalNotice.msg) activeNotice = globalNotice;

    res.json({ activeNotice, history: allNotices });
  } catch (e) {
    res.status(500).json({ error: 'Notice fetch failed: ' + e.message });
  }
});

// ── GET /api/auth/contact-settings ─────────────────────────────────
router.get('/contact-settings', async (req, res) => {
  try {
    const data = await fbGet('contactSettings');
    res.json({
      xUsername: (data && data.xUsername) || 'Z3NITSUxZz',
      tgUsername: (data && data.tgUsername) || 'zenitsu_x777',
    });
  } catch (e) {
    res.status(500).json({ error: 'Contact settings fetch failed: ' + e.message });
  }
});

// ── GET /api/auth/user/:uKey ───────────────────────────────────────
// Generic "give me my own user record" fetch — covers the various
// dashboard reads (loadApiDisplay, updateLimitDisplay, autoLogout
// minutes, xVerified state) that used to be separate fbGet calls
// scattered through popup.js. API keys are still included here since
// this is only ever called for the user's OWN record (their keys are
// theirs to see/manage in the popup) — this is not the AI-generation
// path, where keys never leave the server.
router.get('/user/:uKey', async (req, res) => {
  try {
    const { uKey } = req.params;
    const userData = await fbGet(`users/${uKey}`);
    if (!userData) return res.status(404).json({ error: 'User not found.' });
    res.json(userData);
  } catch (e) {
    res.status(500).json({ error: 'User fetch failed: ' + e.message });
  }
});

module.exports = router;
