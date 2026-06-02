const pool = require('../../config/db');

// ── Cash sessions ───────────────────────────────────────────────────────────

/**
 * Busca la caja OPEN del owner (solo una posible por la unique index parcial).
 * @param {string} ownerUserId
 * @param {import('pg').Pool|import('pg').PoolClient} [db=pool]
 */
const findOpenByOwner = async (ownerUserId, db = pool) => {
  const r = await db.query(
    `SELECT id, business_day_id, owner_user_id, opened_at, opened_by,
            opening_amount::float8 AS opening_amount,
            status, closed_at, closed_by,
            closure_snapshot,
            closure_total_difference::float8 AS closure_total_difference,
            closure_difference_status,
            pending_reconciliation_at, pending_reconciliation_reason,
            reconciled_at, reconciled_by, observations
     FROM cash_sessions
     WHERE owner_user_id = $1 AND status = 'OPEN'
     LIMIT 1`,
    [ownerUserId],
  );
  return r.rows[0] || null;
};

/**
 * Lookup por id, sin joins. Para detalle completo usar findByIdWithDetails.
 */
const findById = async (id, db = pool) => {
  const r = await db.query(
    `SELECT id, business_day_id, owner_user_id, opened_at, opened_by,
            opening_amount::float8 AS opening_amount,
            status, closed_at, closed_by,
            closure_snapshot,
            closure_total_difference::float8 AS closure_total_difference,
            closure_difference_status,
            pending_reconciliation_at, pending_reconciliation_reason,
            reconciled_at, reconciled_by, observations
     FROM cash_sessions WHERE id = $1`,
    [id],
  );
  return r.rows[0] || null;
};

/** Detalle con drops + closure_details + datos del owner. */
const findByIdWithDetails = async (id) => {
  const session = await findById(id);
  if (!session) return null;
  const [owner, drops, details] = await Promise.all([
    pool.query(`SELECT id, full_name, role FROM users WHERE id = $1`, [session.owner_user_id]),
    findDropsBySession(id),
    findClosureDetailsBySession(id),
  ]);
  return {
    ...session,
    owner: owner.rows[0] || null,
    drops,
    closure_details: details,
  };
};

/**
 * Lock + read de la sesión para evitar transiciones concurrentes.
 */
const lockAndGetById = async (client, id) => {
  const r = await client.query(
    `SELECT id, business_day_id, owner_user_id, opening_amount::float8 AS opening_amount,
            status, opened_at, opened_by, closed_at, closed_by, closure_snapshot
     FROM cash_sessions
     WHERE id = $1
     FOR UPDATE`,
    [id],
  );
  return r.rows[0] || null;
};

/**
 * Lista cash_sessions con filtros opcionales.
 * @param {object} filters
 * @param {string} [filters.status]
 * @param {string} [filters.ownerUserId]
 * @param {string} [filters.businessDayId]
 * @param {string} [filters.businessDate]
 * @param {string} [filters.branchId]
 */
const findAll = async (filters = {}) => {
  let q = `
    SELECT cs.id, cs.business_day_id, cs.owner_user_id, cs.opened_at, cs.opened_by,
           cs.opening_amount::float8 AS opening_amount,
           cs.status, cs.closed_at, cs.closed_by,
           cs.closure_total_difference::float8 AS closure_total_difference,
           cs.closure_difference_status,
           cs.pending_reconciliation_at, cs.pending_reconciliation_reason,
           cs.reconciled_at, cs.reconciled_by, cs.observations,
           bd.business_date, bd.branch_id,
           u.full_name AS owner_name
    FROM cash_sessions cs
    JOIN business_days bd ON bd.id = cs.business_day_id
    JOIN users u          ON u.id  = cs.owner_user_id
    WHERE 1=1`;
  const params = [];
  if (filters.status)        { params.push(filters.status);        q += ` AND cs.status = $${params.length}`; }
  if (filters.ownerUserId)   { params.push(filters.ownerUserId);   q += ` AND cs.owner_user_id = $${params.length}`; }
  if (filters.businessDayId) { params.push(filters.businessDayId); q += ` AND cs.business_day_id = $${params.length}`; }
  if (filters.businessDate)  { params.push(filters.businessDate);  q += ` AND bd.business_date = $${params.length}::date`; }
  if (filters.branchId)      { params.push(filters.branchId);      q += ` AND bd.branch_id = $${params.length}`; }
  q += ` ORDER BY cs.opened_at DESC`;
  return (await pool.query(q, params)).rows;
};

const create = async (client, { businessDayId, ownerUserId, openedBy, openingAmount, observations }) => {
  const r = await client.query(
    `INSERT INTO cash_sessions
       (business_day_id, owner_user_id, opened_by, opening_amount, observations)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, business_day_id, owner_user_id, opened_at, opened_by,
               opening_amount::float8 AS opening_amount,
               status, observations`,
    [businessDayId, ownerUserId, openedBy, openingAmount, observations || null],
  );
  return r.rows[0];
};

/**
 * Transición OPEN → CLOSED con snapshot y totales.
 * Guard SQL: solo procede si la sesión está en OPEN.
 */
const close = async (client, id, { closedBy, snapshot, totalDifference, diffStatus }) => {
  const r = await client.query(
    `UPDATE cash_sessions
     SET status = 'CLOSED',
         closed_at = NOW(),
         closed_by = $2,
         closure_snapshot = $3,
         closure_total_difference = $4,
         closure_difference_status = $5
     WHERE id = $1 AND status = 'OPEN'
     RETURNING id, status, closed_at, closure_total_difference::float8 AS closure_total_difference,
               closure_difference_status`,
    [id, closedBy, snapshot, totalDifference, diffStatus],
  );
  return r.rows[0] || null;
};

/**
 * Transición OPEN → PENDING_RECONCILIATION (caja olvidada o marcada manualmente).
 */
const markPending = async (client, id, { reason }) => {
  const r = await client.query(
    `UPDATE cash_sessions
     SET status = 'PENDING_RECONCILIATION',
         pending_reconciliation_at = NOW(),
         pending_reconciliation_reason = $2
     WHERE id = $1 AND status = 'OPEN'
     RETURNING id, status, pending_reconciliation_at, pending_reconciliation_reason`,
    [id, reason],
  );
  return r.rows[0] || null;
};

/**
 * Transición PENDING_RECONCILIATION → CLOSED por un supervisor/admin a posteriori.
 */
const reconcile = async (client, id, { reconciledBy, snapshot, totalDifference, diffStatus }) => {
  const r = await client.query(
    `UPDATE cash_sessions
     SET status = 'CLOSED',
         closed_at = COALESCE(closed_at, NOW()),
         closed_by = $2,
         reconciled_at = NOW(),
         reconciled_by = $2,
         closure_snapshot = $3,
         closure_total_difference = $4,
         closure_difference_status = $5
     WHERE id = $1 AND status = 'PENDING_RECONCILIATION'
     RETURNING id, status, closed_at, reconciled_at, reconciled_by,
               closure_total_difference::float8 AS closure_total_difference,
               closure_difference_status`,
    [id, reconciledBy, snapshot, totalDifference, diffStatus],
  );
  return r.rows[0] || null;
};

// ── Closure details (cierre por método de pago) ────────────────────────────

const insertClosureDetails = async (client, cashSessionId, details) => {
  if (!details || !details.length) return [];
  const values = details.map((_, i) => {
    const b = i * 6;
    return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6})`;
  }).join(', ');
  const params = details.flatMap((d) => [
    cashSessionId, d.payment_method, d.expected_amount, d.declared_amount,
    d.difference, d.difference_status,
  ]);
  const r = await client.query(
    `INSERT INTO cash_session_closure_details
       (cash_session_id, payment_method, expected_amount, declared_amount, difference, difference_status)
     VALUES ${values}
     RETURNING id, payment_method,
               expected_amount::float8 AS expected_amount,
               declared_amount::float8 AS declared_amount,
               difference::float8     AS difference,
               difference_status`,
    params,
  );
  return r.rows;
};

const findClosureDetailsBySession = async (cashSessionId) => {
  const r = await pool.query(
    `SELECT id, payment_method,
            expected_amount::float8 AS expected_amount,
            declared_amount::float8 AS declared_amount,
            difference::float8      AS difference,
            difference_status, notes
     FROM cash_session_closure_details
     WHERE cash_session_id = $1
     ORDER BY payment_method`,
    [cashSessionId],
  );
  return r.rows;
};

// ── Drops (retiros parciales) ──────────────────────────────────────────────

const createDrop = async (client, cashSessionId, {
  amount, paymentMethod, destination, reason, receiptReference, performedBy,
}) => {
  const r = await client.query(
    `INSERT INTO cash_session_drops
       (cash_session_id, amount, payment_method, destination, reason, receipt_reference, performed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, cash_session_id, amount::float8 AS amount, payment_method,
               destination, reason, receipt_reference, status,
               performed_by, performed_at`,
    [cashSessionId, amount, paymentMethod, destination, reason || null, receiptReference || null, performedBy],
  );
  return r.rows[0];
};

const reverseDrop = async (client, dropId, { reversedBy, reason }) => {
  const r = await client.query(
    `UPDATE cash_session_drops
     SET status = 'REVERSED',
         reversed_at = NOW(),
         reversed_by = $2,
         reversed_reason = $3
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING id, status, reversed_at, reversed_by, reversed_reason`,
    [dropId, reversedBy, reason],
  );
  return r.rows[0] || null;
};

const findDropById = async (id, db = pool) => {
  const r = await db.query(
    `SELECT id, cash_session_id, amount::float8 AS amount, payment_method,
            destination, reason, receipt_reference, status,
            performed_by, performed_at, reversed_at, reversed_by, reversed_reason
     FROM cash_session_drops WHERE id = $1`,
    [id],
  );
  return r.rows[0] || null;
};

const findDropsBySession = async (cashSessionId) => {
  const r = await pool.query(
    `SELECT id, amount::float8 AS amount, payment_method, destination, reason,
            receipt_reference, status, performed_by, performed_at,
            reversed_at, reversed_by, reversed_reason
     FROM cash_session_drops
     WHERE cash_session_id = $1
     ORDER BY performed_at DESC`,
    [cashSessionId],
  );
  return r.rows;
};

// ── Totales calculados para X report y snapshot al cierre ──────────────────

/**
 * Calcula totales agregados de la sesión (drops por método). En Fase 1 los
 * movimientos (collections/expenses/etc.) no apuntan todavía a cash_session_id;
 * cuando llegue Fase 2 esta función se extiende para sumarlos desde sus tablas.
 *
 * @param {string} cashSessionId
 * @param {import('pg').Pool|import('pg').PoolClient} [db=pool]
 * @returns {Promise<object>}
 */
const computeSessionTotals = async (cashSessionId, db = pool) => {
  const dropsRes = await db.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE payment_method='CASH'     AND status='ACTIVE'), 0)::float8 AS drops_cash,
       COALESCE(SUM(amount) FILTER (WHERE payment_method='TRANSFER' AND status='ACTIVE'), 0)::float8 AS drops_transfer,
       COUNT(*) FILTER (WHERE status='ACTIVE')::int   AS drops_active_count,
       COUNT(*) FILTER (WHERE status='REVERSED')::int AS drops_reversed_count
     FROM cash_session_drops
     WHERE cash_session_id = $1`,
    [cashSessionId],
  );
  return {
    drops_cash:           dropsRes.rows[0].drops_cash,
    drops_transfer:       dropsRes.rows[0].drops_transfer,
    drops_active_count:   dropsRes.rows[0].drops_active_count,
    drops_reversed_count: dropsRes.rows[0].drops_reversed_count,
    // Stubs para Fase 2 — quedan en cero hasta que los movimientos referencien cash_session_id.
    collections_payments_cash:        0,
    collections_payments_transfer:    0,
    collections_down_payments_cash:   0,
    collections_down_payments_transfer: 0,
    outflows_expenses_cash:           0,
    outflows_expenses_transfer:       0,
    outflows_commissions_cash:        0,
    outflows_commissions_transfer:    0,
    conversions_cash_delta:           0,
    conversions_transfer_delta:       0,
  };
};

module.exports = {
  findOpenByOwner,
  findById,
  findByIdWithDetails,
  lockAndGetById,
  findAll,
  create,
  close,
  markPending,
  reconcile,
  insertClosureDetails,
  findClosureDetailsBySession,
  createDrop,
  reverseDrop,
  findDropById,
  findDropsBySession,
  computeSessionTotals,
};
