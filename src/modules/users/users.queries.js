const pool = require('../../config/db');
const { runListQuery } = require('../../utils/pagination');

const findAll = async ({ role, roles, status, search, pagination } = {}) => {
  let q = `SELECT id, full_name, dni, email, phone, address, role, status, is_temp_password,
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
  q += ` ORDER BY full_name ASC, id ASC`;
  return runListQuery(q, params, pagination);
};

// Columnas del perfil completo (detalle de admin y perfil propio).
const PROFILE_FIELDS = `id, full_name, dni, email, phone, address, role, status, is_temp_password,
            failed_attempts, locked_at, last_login_at, created_at, updated_at`;

const findById = async (id) => {
  const result = await pool.query(
    `SELECT ${PROFILE_FIELDS}
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

const countActiveAdmins = async (db = pool) => {
  const result = await db.query(
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

const findOwnProfileById = async (id) => {
  const result = await pool.query(
    `SELECT ${PROFILE_FIELDS}
     FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
};

/**
 * Normaliza un campo opcional para UPDATE: distingue "no enviado" (undefined →
 * no se toca) de "enviado vacío" ('' o null → NULL).
 * @returns {[boolean, *]} [enviado, valor normalizado]
 */
const optionalField = (value) => [value !== undefined, value === '' ? null : (value ?? null)];

/**
 * Actualiza un usuario (Admin). Obligatorios: null/omitido no cambia.
 * Opcionales (email, address): omitido no cambia; null o '' → NULL (issue #65).
 */
const update = async (id, { full_name, dni, email, address, role }, client = pool) => {
  const result = await client.query(
    `UPDATE users
     SET full_name  = COALESCE($1, full_name),
         dni        = COALESCE($2, dni),
         email      = CASE WHEN $3::boolean THEN $4::varchar ELSE email END,
         address    = CASE WHEN $5::boolean THEN $6::varchar ELSE address END,
         role       = COALESCE($7, role),
         updated_at = NOW()
     WHERE id = $8
     RETURNING id, full_name, dni, email, address, role, status`,
    [full_name, dni, ...optionalField(email), ...optionalField(address), role, id]
  );
  return result.rows[0] || null;
};

/**
 * Actualiza el perfil propio. full_name: null/omitido no cambia.
 * Opcionales (email, phone, address): omitido no cambia; null o '' → NULL (issue #65).
 */
const updateOwnProfile = async (id, { full_name, email, phone, address }) => {
  const result = await pool.query(
    `UPDATE users
     SET full_name  = COALESCE($1, full_name),
         email      = CASE WHEN $2::boolean THEN $3::varchar ELSE email END,
         phone      = CASE WHEN $4::boolean THEN $5::varchar ELSE phone END,
         address    = CASE WHEN $6::boolean THEN $7::varchar ELSE address END,
         updated_at = NOW()
     WHERE id = $8
     RETURNING id, full_name, dni, email, phone, address, role, status,
               is_temp_password, failed_attempts, locked_at, last_login_at,
               created_at, updated_at`,
    [full_name, ...optionalField(email), ...optionalField(phone), ...optionalField(address), id]
  );
  return result.rows[0] || null;
};

/**
 * Bloquea (FOR UPDATE) las filas de admins activos para serializar la guarda
 * del último admin. Orden fijo por id para evitar deadlocks.
 * @param {object} client - Cliente de transacción.
 */
const lockActiveAdmins = async (client) => {
  await client.query(
    `SELECT id FROM users
     WHERE role = 'ADMIN' AND status = 'ACTIVE' AND locked_at IS NULL
     ORDER BY id
     FOR UPDATE`
  );
};

/**
 * Desactiva un usuario solo si sigue activo.
 * @returns {Promise<boolean>} true si efectivamente cambió de estado.
 */
const deactivate = async (id, db = pool) => {
  const r = await db.query(
    `UPDATE users SET status = 'INACTIVE', updated_at = NOW()
     WHERE id = $1 AND status <> 'INACTIVE'`, [id]
  );
  return r.rowCount === 1;
};

const activate = async (id) => {
  await pool.query(
    `UPDATE users SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1`, [id]
  );
};

const resetPassword = async (id, password_hash, client = pool) => {
  await client.query(
    `UPDATE users
     SET password_hash = $1, is_temp_password = TRUE,
         failed_attempts = 0, locked_at = NULL, locked_until = NULL, updated_at = NOW()
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
    `UPDATE users SET locked_at = NULL, locked_until = NULL, failed_attempts = 0, updated_at = NOW() WHERE id = $1`,
    [id]
  );
};

/**
 * Invalida todas las sesiones activas del usuario marcando la fecha del cambio de rol.
 * El middleware compara el iat del token con este timestamp y rechaza tokens anteriores.
 * Requiere: ALTER TABLE users ADD COLUMN force_relogin_at TIMESTAMPTZ;
 */
const setForceReloginAt = async (id, client = pool) => {
  await client.query(
    `UPDATE users SET force_relogin_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id]
  );
};

/**
 * Cierra todas las sesiones del usuario: invalida los access tokens emitidos
 * (force_relogin_at) y revoca sus refresh tokens activos (#42).
 * @param {string} id - id del usuario
 * @param {Object} [client] - client de una transacción en curso (default: pool)
 */
const invalidateSessions = async (id, client = pool) => {
  await setForceReloginAt(id, client);
  await client.query(
    `UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW()
     WHERE user_id = $1 AND revoked = FALSE`,
    [id]
  );
};

module.exports = {
  findAll, findById, findByDni, findByEmail, countActiveAdmins,
  create, update, lockActiveAdmins, deactivate, activate, resetPassword, changePassword, unlock,
  setForceReloginAt, invalidateSessions, findOwnProfileById, updateOwnProfile,
};
