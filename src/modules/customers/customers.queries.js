const pool = require('../../config/db');
const { IS_OVERDUE_DERIVED } = require('../../utils/installmentSql');

const findAll = async ({ status, search, collector_id, include_summary = false, grace_days = 0 } = {}) => {
  const params = [];
  let graceDaysIdx = null;

  // Si se pide el summary, el badge "con mora" usa la condición derivada que
  // necesita grace_days. Se pushea PRIMERO para que las condiciones dinámicas
  // ($2, $3, ...) sigan funcionando con params.length.
  if (include_summary) {
    params.push(grace_days);
    graceDaysIdx = params.length; // = 1
  }

  const summarySelect = include_summary
    ? `,
      COALESCE(cs.active_credits, 0) AS active_credits,
      CASE WHEN COALESCE(ds.overdue_installments, 0) > 0 THEN 'con mora' ELSE 'sin mora' END AS delinquency,
      GREATEST(0, COALESCE(lc.max_credit_amount, 0) - COALESCE(bs.outstanding_balance, 0)) AS payment_capacity`
    : '';

  const summaryJoins = include_summary
    ? `
    CROSS JOIN (
      SELECT COALESCE(MAX(value::numeric), 0) AS max_credit_amount
      FROM system_config
      WHERE key = 'max_credit_amount'
    ) lc
    LEFT JOIN (
      SELECT customer_id, COUNT(*)::int AS active_credits
      FROM credits
      WHERE status = 'ACTIVE'
      GROUP BY customer_id
    ) cs ON cs.customer_id = c.id
    LEFT JOIN (
      SELECT cr.customer_id, COUNT(*)::int AS overdue_installments
      FROM installments i
      INNER JOIN credits cr ON cr.id = i.credit_id
      WHERE ${IS_OVERDUE_DERIVED('i', `$${graceDaysIdx}`)}
      GROUP BY cr.customer_id
    ) ds ON ds.customer_id = c.id
    LEFT JOIN (
      SELECT
        cr.customer_id,
        COALESCE(SUM(GREATEST(i.amount_due - i.amount_paid, 0) + COALESCE(i.penalty_amount, 0)), 0) AS outstanding_balance
      FROM installments i
      INNER JOIN credits cr ON cr.id = i.credit_id
      WHERE cr.status = 'ACTIVE'
        AND i.status IN ('PENDING', 'OVERDUE', 'PARTIAL')
      GROUP BY cr.customer_id
    ) bs ON bs.customer_id = c.id`
    : '';

  let q = `
    SELECT
      c.id, c.full_name, c.dni, c.address, c.phone, c.email,
      c.status, c.portal_enabled, c.created_at,
      u.id        AS collector_id,
      u.full_name AS collector_name
      ${summarySelect}
    FROM customers c
    LEFT JOIN users u ON u.id = c.assigned_collector_id
    ${summaryJoins}
    WHERE 1=1`;

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

/**
 * Devuelve el resumen del cliente para el wizard con información financiera y créditos recientes.
 * @param {string} id
 * @returns {Promise<object | null>}
 */
const findWizardSummaryById = async (id, graceDays = 0) => {
  const [customerRes, creditsRes, statsRes] = await Promise.all([
    pool.query(
      `SELECT
         c.id, c.full_name, c.dni, c.address, c.phone, c.email,
         c.status, c.portal_enabled, c.created_at,
         u.id        AS collector_id,
         u.full_name AS collector_name,
         GREATEST(
           0,
           COALESCE(cfg.max_credit_amount, 0) - COALESCE(balance.outstanding_balance, 0)
         )::float8 AS payment_capacity,
         COALESCE(active.active_credits, 0)::int AS active_credits
       FROM customers c
       LEFT JOIN users u ON u.id = c.assigned_collector_id
       CROSS JOIN (
         SELECT COALESCE(MAX(value::numeric), 0) AS max_credit_amount
         FROM system_config
         WHERE key = 'max_credit_amount'
       ) cfg
       LEFT JOIN (
         SELECT cr.customer_id,
                COALESCE(SUM(GREATEST(i.amount_due - i.amount_paid, 0) + COALESCE(i.penalty_amount, 0)), 0) AS outstanding_balance
         FROM credits cr
         LEFT JOIN installments i ON i.credit_id = cr.id
         WHERE cr.customer_id = $1
           AND cr.status = 'ACTIVE'
           AND i.status IN ('PENDING', 'OVERDUE', 'PARTIAL')
         GROUP BY cr.customer_id
       ) balance ON balance.customer_id = c.id
       LEFT JOIN (
         SELECT customer_id, COUNT(*)::int AS active_credits
         FROM credits
         WHERE customer_id = $1
           AND status = 'ACTIVE'
         GROUP BY customer_id
       ) active ON active.customer_id = c.id
       WHERE c.id = $1`,
      [id]
    ),
    pool.query(
      `SELECT
         c.id,
         c.type,
         c.total_amount::float8,
         c.installments_count::int,
         c.status,
         COALESCE(c.approved_at, c.created_at) AS reference_date,
         (SELECT STRING_AGG(DISTINCT p.title, ' + ')
          FROM credit_products cp
          JOIN product_units pu ON pu.id = cp.product_unit_id
          JOIN product_variants pv ON pv.id = pu.variant_id
          JOIN products p ON p.id = pv.product_id
          WHERE cp.credit_id = c.id) AS credit_name
       FROM credits c
       WHERE c.customer_id = $1
         AND c.status IN ('ACTIVE', 'SETTLED')
       ORDER BY COALESCE(c.approved_at, c.created_at) DESC
       LIMIT 3`,
      [id]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE i.status = 'PAID')::int AS paid_installments,
         COUNT(*) FILTER (WHERE i.status IN ('PENDING', 'PARTIAL'))::int AS pending_installments,
         COUNT(*) FILTER (WHERE ${IS_OVERDUE_DERIVED('i', '$2')})::int AS overdue_installments
       FROM installments i
       INNER JOIN credits c ON c.id = i.credit_id
       WHERE c.customer_id = $1
         AND c.status IN ('ACTIVE', 'SETTLED')`,
      [id, graceDays]
    ),
  ]);

  if (!customerRes.rows[0]) return null;

  return {
    ...customerRes.rows[0],
    ...statsRes.rows[0],
    credits: creditsRes.rows.map((row) => ({
      id: row.id,
      type: row.type,
      credit_name: row.credit_name,
      total_amount: row.total_amount,
      installments_count: row.installments_count,
      status: row.status,
      reference_date: row.reference_date,
    })),
  };
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
  findAll, findById, findWizardSummaryById, findByDni, findCollectorById, hasActiveOrPendingCredits,
  create, update, deactivate, activate,
  enablePortal, disablePortal, resetPortalPassword, unlockPortal,
};
