// services/firebase.js
//
// Server-side Firebase Admin SDK client. This REPLACES the extension's old
// pattern of raw `fetch(FIREBASE_URL + path + '.json')` REST calls with a
// service-account-authenticated Admin SDK connection. The RTDB URL and any
// credentials never touch the browser again — everything the extension
// needs goes through this server's REST API instead.
//
// Env vars required (see .env.example):
//   FIREBASE_SERVICE_ACCOUNT_JSON  - full service account JSON, as a single-line string
//   FIREBASE_DATABASE_URL          - e.g. https://zen-premium-2ab43-default-rtdb.firebaseio.com

const admin = require('firebase-admin');

let app = null;

function initFirebase() {
  if (app) return app;

  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const databaseURL = process.env.FIREBASE_DATABASE_URL;

  if (!rawServiceAccount) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set. See .env.example.');
  }
  if (!databaseURL) {
    throw new Error('FIREBASE_DATABASE_URL is not set. See .env.example.');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(rawServiceAccount);
  } catch (e) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message);
  }

  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL,
  });

  return app;
}

function db() {
  initFirebase();
  return admin.database();
}

// ── Generic helpers, mirroring the extension's old fbGet/fbUpdate/fbSet/fbPush/fbDelete shape ──
// so porting call sites from popup.js/content.js/background.js is mostly mechanical.

async function fbGet(path) {
  const snap = await db().ref(path).get();
  return snap.exists() ? snap.val() : null;
}

async function fbUpdate(path, data) {
  await db().ref(path).update(data);
  return true;
}

async function fbSet(path, data) {
  await db().ref(path).set(data);
  return true;
}

async function fbPush(path, data) {
  const ref = await db().ref(path).push(data);
  return ref.key;
}

async function fbDelete(path) {
  await db().ref(path).remove();
  return true;
}

// Same derivation the extension has always used for Firebase-safe user keys.
function emailToKey(email) {
  return String(email).replace(/\./g, '_dot_').replace(/@/g, '_at_');
}

module.exports = {
  initFirebase,
  db,
  fbGet,
  fbUpdate,
  fbSet,
  fbPush,
  fbDelete,
  emailToKey,
};
