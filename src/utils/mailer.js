// ── Wrapper de envío de email vía nodemailer + SMTP ───────────────────────
//
// Diseño deliberado: best-effort, nunca rompe el flujo que lo invoca.
// Si faltan las variables de entorno SMTP (típico en desarrollo local sin
// servidor de correo configurado), sendMail loguea un warning y resuelve
// en no-op — nunca lanza. El caller (notifications.service.js) es
// responsable de invocar esto SOLO post-commit de su transacción de negocio.

const nodemailer = require("nodemailer");

let cachedTransport = null;

/**
 * Indica si las variables de entorno mínimas para SMTP están configuradas.
 * @returns {boolean}
 */
const isSmtpConfigured = () =>
  Boolean(
    process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS,
  );

/**
 * Construye (y cachea) el transporte nodemailer a partir de las variables
 * de entorno SMTP_HOST/PORT/USER/PASS/SECURE.
 * @returns {import('nodemailer').Transporter}
 */
const getTransport = () => {
  if (cachedTransport) return cachedTransport;
  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return cachedTransport;
};

/**
 * Envía un email best-effort. Si SMTP no está configurado, loguea un warning
 * y no hace nada (no lanza). Pensado para invocarse fuera de transacciones de
 * negocio — un fallo de SMTP nunca debe revertir ni interrumpir una operación.
 * @param {object} params
 * @param {string} params.to - Dirección destino.
 * @param {string} params.subject - Asunto del correo.
 * @param {string} params.html - Cuerpo HTML del correo.
 * @returns {Promise<void>}
 */
const sendMail = async ({ to, subject, html }) => {
  if (!isSmtpConfigured()) {
    console.warn(
      "⚠️  [mailer] SMTP no configurado (faltan SMTP_HOST/SMTP_USER/SMTP_PASS) — email no enviado:",
      subject,
    );
    return;
  }

  const transport = getTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
  });
};

module.exports = { sendMail, isSmtpConfigured };
