const pool = require('../../config/db');

const findUserByDni = async (dni) => {
  const result = await pool.query(
    `SELECT id, full_name, dni, email, password_hash, role, status,
            is_temp_password, failed_attempts, locked_at
     FROM users WHERE dni = $1`,
    [dni]
  );
  return result.rows[0] || null;
};

const findCustomerByDni = async (dni) => {
  const result = await pool.query(
    `SELECT id, full_name, dni, status, portal_enabled,
            portal_password_hash, portal_is_temp_password,
            portal_failed_attempts, portal_locked_at
     FROM customers WHERE dni = $1`,
    [dni]
  );
  return result.rows[0] || null;
};

const incrementFailedAttempts = async (userId) => {
  await pool.query(
    `UPDATE users SET failed_attempts = failed_attempts + 1, updated_at = NOW() WHERE id = $1`,
    [userId]
  );
};

const lockUser = async (userId) => {
  await pool.query(
    `UPDATE users SET locked_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [userId]
  );
};

const resetFailedAttempts = async (userId) => {
  await pool.query(
    `UPDATE users SET failed_attempts = 0, last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [userId]
  );
};

const incrementPortalFailedAttempts = async (customerId) => {
  await pool.query(
    `UPDATE customers SET portal_failed_attempts = portal_failed_attempts + 1, updated_at = NOW() WHERE id = $1`,
    [customerId]
  );
};

const lockCustomer = async (customerId) => {
  await pool.query(
    `UPDATE customers SET portal_locked_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [customerId]
  );
};

const resetPortalFailedAttempts = async (customerId) => {
  await pool.query(
    `UPDATE customers SET portal_failed_attempts = 0, updated_at = NOW() WHERE id = $1`,
    [customerId]
  );
};

const findCustomerPasswordHash = async (id) => {
  const result = await pool.query(
    `SELECT portal_password_hash, portal_is_temp_password FROM customers WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
};

const changePortalPassword = async (id, passwordHash) => {
  await pool.query(
    `UPDATE customers
     SET portal_password_hash    = $1,
         portal_is_temp_password = FALSE,
         portal_failed_attempts  = 0,
         updated_at              = NOW()
     WHERE id = $2`,
    [passwordHash, id]
  );
};

const blacklistToken = async (jti, userId, customerId, expiresAt) => {
  await pool.query(
    `INSERT INTO token_blacklist (token_jti, user_id, customer_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [jti, userId || null, customerId || null, expiresAt]
  );
};

const cleanExpiredTokens = async () => {
  const result = await pool.query(`DELETE FROM token_blacklist WHERE expires_at < NOW()`);
  return result.rowCount;
};

module.exports = {
  findUserByDni, findCustomerByDni, findCustomerPasswordHash,
  incrementFailedAttempts, lockUser, resetFailedAttempts,
  incrementPortalFailedAttempts, lockCustomer, resetPortalFailedAttempts,
  changePortalPassword,
  blacklistToken, cleanExpiredTokens,
};
