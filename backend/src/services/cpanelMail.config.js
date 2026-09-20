require('dotenv').config();

/* ============================================================
 * CONFIG SMTP CORPORATIVO (cPanel / cPanel Mail) — NODE
 * ============================================================
 * Provee las credenciales de salida del correo corporativo de
 * North Services para Nodemailer.
 *
 * Si faltan credenciales en el .env se devuelve null (defensivo)
 * y corporateEmail.service.js responderá MAIL_NOT_CONFIGURED
 * SIN lanzar excepción, para no romper /api/password/solicitar.
 *
 * Variables esperadas en el .env (backend):
 *   CPANEL_MAIL_HOST, CPANEL_MAIL_PORT, CPANEL_MAIL_SECURE,
 *   CPANEL_MAIL_USER, CPANEL_MAIL_PASS,
 *   CPANEL_MAIL_FROM_NAME, CPANEL_MAIL_FROM_EMAIL
 * ============================================================ */

const host  = String(process.env.CPANEL_MAIL_HOST || '').trim();
const user  = String(process.env.CPANEL_MAIL_USER || '').trim();
const pass  = String(process.env.CPANEL_MAIL_PASS || '').trim();

if (!host || !user || !pass) {
  module.exports = null;
} else {
  module.exports = {
    host,
    port: parseInt(process.env.CPANEL_MAIL_PORT || '465', 10),
    secure: String(process.env.CPANEL_MAIL_SECURE || 'true') === 'true',
    user,
    pass,
    fromName: String(process.env.CPANEL_MAIL_FROM_NAME || 'North Services').trim(),
    fromEmail: String(process.env.CPANEL_MAIL_FROM_EMAIL || user).trim(),
  };
}
