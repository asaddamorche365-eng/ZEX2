// middleware/auth.js
//
// Closes the gap called out in the migration brief: previously the
// extension trusted its own client-reported session state (expiresAt,
// active flag, autoLogoutMinutes) with no server-side check. Every
// AI-generation and feature-flag request now re-validates against
// Firebase on the server before doing anything.
//
// Expected request shape: header `x-zex-email` (or body/query `email`)
// identifying the user. The extension already knows the logged-in
// email from zenDeviceSession, so it just needs to send it along.
//
// This is deliberately simple (email-identified, not a bearer-token
// JWT scheme) to match the extension's existing email+password login
// model without a bigger auth rework. It still fixes the actual gap:
// server-side re-checking of active/expiresAt/apiLocked on every call.

const { fbGet, emailToKey } = require('../services/firebase');

function extractEmail(req) {
  return (
    req.headers['x-zex-email'] ||
    (req.body && req.body.email) ||
    (req.query && req.query.email) ||
    null
  );
}

async function requireActiveUser(req, res, next) {
  try {
    const email = extractEmail(req);
    if (!email) {
      return res.status(401).json({ error: 'Missing user email identification.' });
    }

    const uKey = emailToKey(email);
    const userData = await fbGet(`users/${uKey}`);

    if (!userData) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (!userData.active) {
      return res.status(403).json({ error: 'Account disabled.' });
    }
    if (typeof userData.expiresAt === 'number' && Date.now() >= userData.expiresAt) {
      return res.status(403).json({ error: 'Subscription has ended.' });
    }
    if (userData.apiLocked) {
      return res.status(403).json({ error: 'Contact Admin', locked: true });
    }

    // Attach for downstream route handlers so they don't have to re-fetch.
    req.zexUser = { email, uKey, data: userData };
    next();
  } catch (e) {
    res.status(500).json({ error: 'Auth check failed: ' + e.message });
  }
}

// Simple shared-secret gate for admin endpoints, per the migration brief's
// "first pass" admin auth (env var ADMIN_SECRET). A proper admin UI with
// its own login is a follow-up, not required for this migration.
function requireAdminSecret(req, res, next) {
  const provided = req.headers['x-admin-secret'] || (req.body && req.body.adminSecret);
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    return res.status(500).json({ error: 'Server misconfigured: ADMIN_SECRET not set.' });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Invalid or missing admin secret.' });
  }
  next();
}

module.exports = { requireActiveUser, requireAdminSecret, extractEmail };
