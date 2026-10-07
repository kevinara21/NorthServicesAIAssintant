const { initializeApp, cert, getApps, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const path = require('path');
const fs = require('fs');

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

if (getApps().length === 0) {
  const usarCredencialesAdministradas = process.env.NODE_ENV === 'production'
    || Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const archivoLocal = fs.existsSync(serviceAccountPath)
    ? serviceAccountPath
    : fs.existsSync(legacyServiceAccountPath)
      ? legacyServiceAccountPath
      : null;
  const credential = usarCredencialesAdministradas || !archivoLocal
    ? applicationDefault()
    : cert(require(archivoLocal));

  initializeApp({
    credential,
  });
}

const db = getFirestore();
const authAdmin = getAuth();

module.exports = { db, authAdmin, FieldValue };