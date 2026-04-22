const pool = require('../../config/db');

const findAll = async ({ status, search, collector_id } = {}) => {
  let q = `
    SELECT
      c.id, c.full_name, c.dni, c.address, c.phone, c.email,
      c.status, c.portal_enabled, c.created_at,
      u.id        AS collector_id,
      u.full_name AS collector_name
    FROM customers c
    LEFT JOIN users u ON u.id = c.assigned_collector_id
    WHERE 1=1`;
  const params = [];

  if (status) {
    params.push(status);
    q += ` AND c.status = $${params.length}`;
  }
  if (collector_id) {
    params.push(collector_id);
    q += ` AND c.assigned_collector_id = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    q += ` AND (c.full_name ILIKE $${params.length}
               OR c.dni      ILIKE $${params.length}
               OR c.phone    ILIKE $${params.length})`;
  }
  q += ` ORDER BY c.full_name ASC`;
  const result = await pool.query(q, params);
  return result.rows;
};

const findById = async (id) => {
  const result = await pool.query(
    `SELECT
       c.id, c.full_name, c.dni, c.address, c.phone, c.email,
       c.status, c.portal_enabled, c.portal_is_temp_password,
       c.portal_failed_attempts, c.portal_locked_at,
       c.created_at, c.updated_at,
       u.id        AS collector_id,
       u.full_name AS collector_name
     FROM customers c
     LEFT JOIN users u ON u.id = c.assigned_collector_id
     WHERE c.id = $1`,
    [id]
  );
  return result.rows[0] || null;
};

const findByDni = async (dni) => {
  const result = await pool.query(
    `SELECT id FROM customers WHERE dni = $1`, [dni]
  );
  return result.rows[0] || null;
};

/**
 * Verifica que el usuario con el id dado exista, esté activo y sea COLLECTOR o SELLER_COLLECTOR.
 */
const findCollectorById = async (id) => {
  const result = await pool.query(
    `SELECT id FROM users WHERE id = $1 AND role IN ('COLLECTOR','SELLER_COLLECTOR') AND status = 'ACTIVE'`,
    [id]
  );
  return result.rows[0] || null;
};

/**
 * Bloquea la baja del cliente si tiene créditos activos O pendientes de aprobación (CU03).
 */
const hasActiveOrPendingCredits = async (id) => {
  const result = await pool.query(
    `SELECT id FROM credits
     WHERE customer_id = $1 AND status IN ('ACTIVE', 'PENDING_APPROVAL')
     LIMIT 1`,
    [id]
  );
  return result.rows.length > 0;
};

const create = async ({ full_name, dni, address, phone, email, assigned_collector_id }) => {
  const result = await pool.query(
    `INSERT INTO customers
       (full_name, dni, address, phone, email, assigned_collector_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, full_name, dni, address, phone, email, status,
               portal_enabled, created_at`,
    [full_name, dni, address || null, phone || null, email || null, assigned_collector_id || null]
  );
  return result.rows[0];
};

const update = async (id, { full_name, address, phone, email, assigned_collector_id }) => {
  const result = await pool.query(
    `UPDATE customers
     SET full_name             = COALESCE($1, full_name),
         address               = COALESCE($2, address),
         phone                 = COALESCE($3, phone),
         email                 = COALESCE($4, email),
         assigned_collector_id = COALESCE($5, assigned_collector_id),
         updated_at            = NOW()
     WHERE id = $6
     RETURNING id, full_name, dni, address, phone, email,
               status, assigned_collector_id, updated_at`,
    [full_name, address, phone, email, assigned_collector_id, id]
  );
  return result.rows[0] || null;
};

const deactivate = async (id) => {
  await pool.query(
    `UPDATE customers SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1`, [id]
  );
};

const activate = async (id) => {
  await pool.query(
    `UPDATE customers SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1`, [id]
  );
};

// ── Portal público ────────────────────────────────────────────

const enablePortal = async (id, password_hash) => {
  await pool.query(
    `UPDATE customers
     SET portal_enabled          = TRUE,
         portal_password_hash    = $1,
         portal_is_temp_password = TRUE,
         portal_failed_attempts  = 0,
         portal_locked_at        = NULL,
         updated_at              = NOW()
     WHERE id = $2`,
    [password_hash, id]
  );
};

const disablePortal = async (id) => {
  await pool.query(
    `UPDATE customers
     SET portal_enabled = FALSE, updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
};

const resetPortalPassword = async (id, password_hash) => {
  await pool.query(
    `UPDATE customers
     SET portal_password_hash    = $1,
         portal_is_temp_password = TRUE,
         portal_failed_attempts  = 0,
         portal_locked_at        = NULL,
         updated_at              = NOW()
     WHERE id = $2`,
    [password_hash, id]
  );
};

const unlockPortal = async (id) => {
  await pool.query(
    `UPDATE customers
     SET portal_locked_at       = NULL,
         portal_failed_attempts = 0,
         updated_at             = NOW()
     WHERE id = $1`,
    [id]
  );
};

module.exports = {
  findAll, findById, findByDni, findCollectorById, hasActiveOrPendingCredits,
  create, update, deactivate, activate,
  enablePortal, disablePortal, resetPortalPassword, unlockPortal,
};
