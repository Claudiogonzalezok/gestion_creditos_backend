const pool = require('../../config/db');

/**
 * Usuarios internos activos con ese email (comparación sin mayúsculas).
 * @param {string} email
 * @returns {Promise<{id: string, full_name: string, email: string}[]>}
 */
const findActiveUsersByEmail = async (email) => {
  const r = await pool.query(
    `SELECT id, full_name, email FROM users
     WHERE LOWER(email) = LOWER($1) AND status = 'ACTIVE'`,
    [email]
  );
  return r.rows;
};

/**
 * Invalida los tokens pendientes del usuario y crea uno nuevo.
 * @param {Object} client - client de transacción
 * @param {string} userId
 * @param {string} tokenHash - SHA-256 hex del token
 * @param {number} expiryMinutes
 */
const replaceToken = async (client, userId, tokenHash, expiryMinutes) => {
  await client.query(
    `UPDATE password_reset_tokens SET used_at = NOW()
     WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );
  await client.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + make_interval(mins => $3))`,
    [userId, tokenHash, expiryMinutes]
  );
};

/**
 * Consume un token vigente de forma atómica (un solo uso): solo una
 * transacción concurrente obtiene la fila.
 * @param {Object} client - client de transacción
 * @param {string} tokenHash
 * @returns {Promise<{user_id: string}|null>}
 */
const consumeToken = async (client, tokenHash) => {
  const r = await client.query(
    `UPDATE password_reset_tokens t SET used_at = NOW()
     FROM users u
     WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW()
       AND u.id = t.user_id AND u.status = 'ACTIVE'
     RETURNING t.user_id`,
    [tokenHash]
  );
  return r.rows[0] || null;
};

module.exports = { findActiveUsersByEmail, replaceToken, consumeToken };
