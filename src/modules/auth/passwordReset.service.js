const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const queries = require('./passwordReset.queries');
const usersQueries = require('../users/users.queries');
const notifier = require('../notifications/notifier');
const { getValue } = require('../systemConfig/systemConfig.queries');
const { withTransaction } = require('../../utils/transaction');

const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10');

/**
 * Hash SHA-256 hex del token en claro (lo único que se persiste).
 * @param {string} token
 * @returns {string}
 */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * URL base de la pantalla de reseteo del frontend.
 * PASSWORD_RESET_URL o, en su defecto, el primer ALLOWED_ORIGINS + /reset-password.
 * @returns {string}
 */
const resetBaseUrl = () => {
  if (process.env.PASSWORD_RESET_URL) return process.env.PASSWORD_RESET_URL.trim();
  const origin = (process.env.ALLOWED_ORIGINS || 'http://localhost:4200')
    .split(',')[0].trim().replace(/\/+$/, '');
  return `${origin}/reset-password`;
};

/**
 * Solicita la recuperación de contraseña de un usuario interno por email.
 * La respuesta al cliente es siempre la misma exista o no el usuario: los
 * fallos de envío se registran pero no se propagan. Solo falla (503) si no hay
 * transporte configurado, y eso se decide antes de buscar al usuario.
 * @param {string} email
 * @returns {Promise<void>}
 */
const requestReset = async (email) => {
  if (!notifier.isConfigured()) throw notifier.notConfiguredError();

  const users = await queries.findActiveUsersByEmail(email);
  if (users.length === 0) return;

  const expiryMinutes = parseInt(await getValue('password_reset_expiry_min'), 10) || 30;

  for (const user of users) {
    const token = crypto.randomBytes(32).toString('base64url');
    await withTransaction((client) => queries.replaceToken(client, user.id, hashToken(token), expiryMinutes));
    try {
      await notifier.send({
        to: user.email,
        subject: 'Recuperación de contraseña',
        text:
          `Hola ${user.full_name}:\n\n` +
          `Para elegir una nueva contraseña ingresá a:\n${resetBaseUrl()}?token=${token}\n\n` +
          `El enlace vence en ${expiryMinutes} minutos y sirve una sola vez. ` +
          'Si no lo pediste, ignorá este mensaje.',
      });
    } catch (err) {
      console.error('🔴  No se pudo enviar el email de recuperación:', err.message);
    }
  }
};

/**
 * Consume el token y fija la nueva contraseña. Cierra todas las sesiones del
 * usuario en la misma transacción.
 * @param {string} token - token en claro recibido por email
 * @param {string} newPassword
 * @returns {Promise<void>}
 */
const resetPassword = async (token, newPassword) => {
  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await withTransaction(async (client) => {
    const row = await queries.consumeToken(client, hashToken(token));
    if (!row) {
      throw {
        status: 400,
        code: 'INVALID_RESET_TOKEN',
        message: 'El enlace de recuperación es inválido o venció. Solicitá uno nuevo.',
      };
    }
    await usersQueries.setPasswordFromReset(row.user_id, passwordHash, client);
    await usersQueries.invalidateSessions(row.user_id, client);
  });
};

module.exports = { requestReset, resetPassword, hashToken, resetBaseUrl };
