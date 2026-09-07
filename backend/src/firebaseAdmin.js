const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const path = require('path');

const serviceAccountPath = path.join(
  __dirname,
  '..',
  'serviceAccountKey.json'
);
const legacyServiceAccountPath = path.join(
  __dirname,
  '..',
  'serviceAccountKey.json.json'
);
const resolvedServiceAccountPath = require('fs').existsSync(serviceAccountPath)
  ? serviceAccountPath
  : legacyServiceAccountPath;
const serviceAccount = require(resolvedServiceAccountPath);

if (getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount),
  });
}

const db = getFirestore();
const authAdmin = getAuth();

module.exports = { db, authAdmin, FieldValue };