const pool = require('../../config/db');

const findAll = async ({ role, roles, status, search } = {}) => {
  let q = `SELECT id, full_name, dni, email, address, role, status, is_temp_password,
                  failed_attempts, locked_at, last_login_at, created_at
           FROM users WHERE 1=1`;
  const params = [];
  // `role` = match exacto (compat). `roles` = conjunto (ej: cobradores =
  // COLLECTOR + SELLER_COLLECTOR, vendedores = SELLER + SELLER_COLLECTOR).
  if (role) {
    params.push(role);
    q += ` AND role = $${params.length}`;
  } else if (Array.isArray(roles) && roles.length) {
    params.push(roles);
    q += ` AND role = ANY($${params.length}::text[])`;
  }
  if (status) { params.push(status); q += ` AND status = $${params.length}`; }
  if (search) {
    params.push(`%${search}%`);
    q += ` AND (full_name ILIKE $${params.length} OR dni ILIKE $${params.length} OR email ILIKE $${params.length})`;
  }
  q += ` ORDER BY full_name ASC`;
  const result = await pool.query(q, params);
  return result.rows;
};

const findById = async (id) => {
  const result = await pool.query(
    `SELECT id, full_name, dni, email, address, role, status, is_temp_password,
            failed_attempts, locked_at, last_login_at, created_at, updated_at
     FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
};

const findByDni = async (dni) => {
  const result = await pool.query(`SELECT id FROM users WHERE dni = $1`, [dni]);
  return result.rows[0] || null;
};

const findByEmail = async (email) => {
  if (!email) return null;
  const result = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  return result.rows[0] || null;
};

const countActiveAdmins = async () => {
  const result = await pool.query(
    `SELECT COUNT(*) FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND locked_at IS NULL`
  );
  return parseInt(result.rows[0].count);
};

const create = async ({ full_name, dni, email, address, password_hash, role }) => {
  const result = await pool.query(
    `INSERT INTO users (full_name, dni, email, address, password_hash, role, is_temp_password)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE)
     RETURNING id, full_name, dni, email, address, role, status, is_temp_password, created_at`,
    [full_name, dni, email || null, address || null, password_hash, role]
  );
  return result.rows[0];
};

const update = async (id, { full_name, dni, email, address, role }) => {
  const result = await pool.query(
    `UPDATE users
     SET full_name  = COALESCE($1, full_name),
         dni        = COALESCE($2, dni),
         email      = COALESCE($3, email),
         address    = COALESCE($4, address),
         role       = COALESCE($5, role),
         updated_at = NOW()
     WHERE id = $6
     RETURNING id, full_name, dni, email, address, role, status`,
    [full_name, dni, email, address, role, id]
  );
  return result.rows[0] || null;
};

const deactivate = async (id) => {
  await pool.query(
    `UPDATE users SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1`, [id]
  );
};

const activate = async (id) => {
  await pool.query(
    `UPDATE users SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1`, [id]
  );
};

const resetPassword = async (id, password_hash) => {
  await pool.query(
    `UPDATE users
     SET password_hash = $1, is_temp_password = TRUE,
         failed_attempts = 0, locked_at = NULL, updated_at = NOW()
     WHERE id = $2`,
    [password_hash, id]
  );
};

const changePassword = async (id, password_hash) => {
  await pool.query(
    `UPDATE users
     SET password_hash = $1, is_temp_password = FALSE, updated_at = NOW()
     WHERE id = $2`,
    [password_hash, id]
  );
};

const unlock = async (id) => {
  await pool.query(
    `UPDATE users SET locked_at = NULL, failed_attempts = 0, updated_at = NOW() WHERE id = $1`,
    [id]
  );
};

/**
 * Invalida todas las sesiones activas del usuario marcando la fecha del cambio de rol.
 * El middleware compara el iat del token con este timestamp y rechaza tokens anteriores.
 * Requiere: ALTER TABLE users ADD COLUMN force_relogin_at TIMESTAMPTZ;
 */
const setForceReloginAt = async (id) => {
  await pool.query(
    `UPDATE users SET force_relogin_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id]
  );
};

module.exports = {
  findAll, findById, findByDni, findByEmail, countActiveAdmins,
  create, update, deactivate, activate, resetPassword, changePassword, unlock,
  setForceReloginAt,
};
