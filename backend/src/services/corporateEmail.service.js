// ==========================================================
// SERVICIO DE CORREO CORPORATIVO
// North Services AI Assistant
// ==========================================================
//
// Envía correos HTML desde la cuenta corporativa de cPanel
// mediante el SMTP del hosting.
//
// Módulo AUTOCONTENIDO para los endpoints de autenticación
// y recuperación/cambio de contraseña.
//
// Uso típico desde server.js:
//
//   const corporateMail = require('./services/corporateEmail.service');
//
//   const { ok, error } = await corporateMail.enviarOtpCorporativo({
//     para: 'juan.perez@northservices.com.pe',
//     nombreUsuario: 'Juan Pérez',
//     otp: '483920',
//     minutosExpiracion: 5,
//   });
//
// Si el SMTP no está configurado devuelve { ok:false }
// sin lanzar excepciones para no romper el endpoint.
// ==========================================================

require('dotenv').config();

const nodemailer = require('nodemailer');
const CpanelMailConfig = require('./cpanelMail.config');

// ==========================================================
// TRANSPORTE SMTP ÚNICO Y REUTILIZABLE
// ==========================================================

let transporte = null;

function obtenerTransporte() {
  if (transporte) {
    return transporte;
  }

  if (
    !CpanelMailConfig ||
    !CpanelMailConfig.host ||
    !CpanelMailConfig.user ||
    !CpanelMailConfig.pass
  ) {
    return null;
  }

  transporte = nodemailer.createTransport({
    host: CpanelMailConfig.host,
    port: CpanelMailConfig.port,
    secure: CpanelMailConfig.secure,
    auth: {
      user: CpanelMailConfig.user,
      pass: CpanelMailConfig.pass,
    },
  });

  return transporte;
}

// ==========================================================
// PLANTILLA HTML
// CAMBIO / RECUPERACIÓN DE CONTRASEÑA
// NORTH SERVICES AI ASSISTANT
// ==========================================================

function plantillaOtpHtml({
  otp,
  nombreUsuario = '',
  minutos = 5,
}) {
  // Limpiar nombre para evitar insertar HTML.
  const nom = String(nombreUsuario || '')
    .replace(/[<>&"']/g, '');

  // El OTP debe mostrar únicamente números.
  const codigo = String(otp || '')
    .replace(/[^0-9]/g, '');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />

  <title>Código de seguridad</title>

  <style>
    @media only screen and (max-width: 480px) {
      .outer-pad  { padding: 16px 8px !important; }
      .head-pad   { padding: 22px 16px !important; }
      .body-pad   { padding: 26px 20px !important; }
      .foot-pad   { padding: 18px 20px !important; }
      .brand      { font-size: 18px !important; }
      .otp        { font-size: 32px !important; letter-spacing: 6px !important; }
    }
  </style>
</head>

<body
  style="
    margin:0;
    padding:0;
    background:#eef1f0;
    font-family:Arial,Helvetica,sans-serif;
    color:#111111;
  "
>

  <table
    role="presentation"
    width="100%"
    cellpadding="0"
    cellspacing="0"
    border="0"
    style="
      width:100%;
      background:#eef1f0;
    "
  >

    <tr>
      <td
        align="center"
        class="outer-pad"
        style="padding:32px 12px;"
      >

        <!-- ==================================================
             TARJETA PRINCIPAL (FLUIDA: OCUPA TODO EL ANCHO)
             Si en pantallas muy grandes se ve demasiado ancha,
             agrega  max-width:900px;  al style de esta tabla.
             ================================================== -->

        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
          style="
            width:100%;
            background:#ffffff;
            border-radius:12px;
            overflow:hidden;
            box-shadow:0 6px 24px rgba(0,0,0,0.08);
          "
        >

          <!-- ==================================================
               ENCABEZADO (UNA SOLA LÍNEA, CENTRADO)
               ================================================== -->

          <tr>
            <td
              align="center"
              class="head-pad"
              style="
                background:#111111;
                padding:28px 32px;
                text-align:center;
              "
            >

              <div
                class="brand"
                style="
                  font-size:22px;
                  line-height:1.2;
                  font-weight:700;
                  letter-spacing:0.6px;
                  color:#ffffff;
                  white-space:nowrap;
                "
              >North <span style="color:#DD2226;">Services</span> <span style="color:#a8a8a8;">AI Assistant</span></div>

            </td>
          </tr>


          <!-- ==================================================
               CONTENIDO
               ================================================== -->

          <tr>
            <td
              class="body-pad"
              style="
                padding:36px 32px 34px 32px;
              "
            >

              <!-- TÍTULO -->

              <h1
                style="
                  margin:0 0 14px 0;
                  padding:0;
                  font-size:25px;
                  line-height:1.3;
                  font-weight:700;
                  color:#111111;
                "
              >
                Cambio de contraseña
              </h1>


              <!-- SALUDO + MENSAJE (salto de línea después del Hola) -->

              <p
                style="
                  margin:0 0 24px 0;
                  padding:0;
                  font-size:15px;
                  line-height:1.7;
                  color:#4b5563;
                "
              >Hola${nom ? ` <strong style="color:#111111;">${nom}</strong>` : ''}, recibimos una solicitud para cambiar la contraseña de tu cuenta de <strong style="color:#111111;">North Services AI Assistant</strong>.</p>


              <!-- ==================================================
                   CÓDIGO
                   ================================================== -->

              <p
                style="
                  margin:0 0 10px 0;
                  padding:0;
                  font-size:14px;
                  line-height:1.5;
                  color:#4b5563;
                "
              >
                Utiliza este código de verificación:
              </p>


              <table
                role="presentation"
                width="100%"
                cellpadding="0"
                cellspacing="0"
                border="0"
                style="
                  width:100%;
                  margin:0 0 24px 0;
                "
              >

                <tr>

                  <td
                    align="center"
                    style="
                      background:#f5f6f6;
                      border-radius:10px;
                      padding:24px 16px;
                    "
                  >

                    <div
                      class="otp"
                      style="
                        font-family:Arial,Helvetica,sans-serif;
                        font-size:40px;
                        line-height:1.2;
                        font-weight:700;
                        letter-spacing:9px;
                        color:#DD2226;
                      "
                    >${codigo}</div>

                  </td>

                </tr>

              </table>


              <!-- ==================================================
                   EXPIRACIÓN
                   ================================================== -->

              <p
                style="
                  margin:0 0 22px 0;
                  padding:0;
                  font-size:14px;
                  line-height:1.7;
                  color:#4b5563;
                "
              >Este código estará disponible durante <strong style="color:#111111;">${minutos} minutos</strong>. No compartas este código con ninguna otra persona.</p>


              <!-- ==================================================
                   SEGURIDAD
                   ================================================== -->

              <p
                style="
                  margin:0 0 24px 0;
                  padding:0;
                  font-size:13px;
                  line-height:1.7;
                  color:#4b5563;
                "
              >
                Si tú no solicitaste cambiar la contraseña,
                puedes ignorar este mensaje. Tu cuenta permanecerá
                protegida mientras no completes el proceso de cambio.
              </p>


              <!-- ==================================================
                   SOPORTE
                   ================================================== -->

              <p
                style="
                  margin:0;
                  padding:0;
                  font-size:13px;
                  line-height:1.7;
                  color:#4b5563;
                "
              >Si necesitas ayuda, contacta al área de sistemas en <a href="mailto:soporte@northservices.com.pe" style="color:#DD2226;text-decoration:none;font-weight:600;">soporte@northservices.com.pe</a>.</p>

            </td>
          </tr>


          <!-- ==================================================
               PIE DE CORREO
               ================================================== -->

          <tr>

            <td
              align="center"
              class="foot-pad"
              style="
                background:#111111;
                padding:22px 32px;
                text-align:center;
              "
            >

              <div
                style="
                  font-size:11px;
                  line-height:1.6;
                  color:#888888;
                  text-align:center;
                "
              >
                © ${new Date().getFullYear()} North Services AI Assistant
                &nbsp;·&nbsp;
                Mensaje automático. Por favor, no responder.
              </div>

            </td>

          </tr>

        </table>

      </td>
    </tr>

  </table>

</body>
</html>`;
}


// ==========================================================
// ENVÍO DEL CORREO OTP
// ==========================================================

/**
 * Envía el correo corporativo con el OTP.
 *
 * @param {object} opts
 * @param {string} opts.para
 *        Correo destino.
 *
 * @param {string} opts.nombreUsuario
 *        Nombre para el saludo (opcional).
 *
 * @param {string} opts.otp
 *        Código de 6 dígitos.
 *
 * @param {number} opts.minutosExpiracion
 *        Expiración mostrada en el correo (default 5).
 *
 * @returns {Promise<{
 *   ok:boolean,
 *   error?:string,
 *   messageId?:string
 * }>}
 */

async function enviarOtpCorporativo(opts) {
  const {
    para,
    nombreUsuario,
    otp,
    minutosExpiracion = 5,
  } = opts;

  const t = obtenerTransporte();

  if (!t) {
    return {
      ok: false,
      error: 'MAIL_NOT_CONFIGURED',
    };
  }

  try {
    const info = await t.sendMail({
      from: `"${CpanelMailConfig.fromName}" <${CpanelMailConfig.user}>`,

      to: para,

      subject:
        'Código para cambiar tu contraseña - North Services AI Assistant',

      html: plantillaOtpHtml({
        otp,
        nombreUsuario,
        minutos: minutosExpiracion,
      }),
    });

    return {
      ok: true,
      messageId: info.messageId,
    };

  } catch (error) {

    // Nunca registramos el OTP en logs.
    return {
      ok: false,
      error: error.message || 'SMTP_ERROR',
    };
  }
}


// ==========================================================
// EXPORTACIONES
// ==========================================================

module.exports = {
  enviarOtpCorporativo,
  plantillaOtpHtml,
};