const pool = require('../../config/db');

// ── Branches (helpers livianos; el módulo de branches per se se hará luego) ─

const findActiveBranchById = async (id, db = pool) => {
  const r = await db.query(
    `SELECT id, code, name, is_active FROM branches
     WHERE id = $1 AND is_active = TRUE`,
    [id],
  );
  return r.rows[0] || null;
};

/** Devuelve la sucursal default ('HQ'), o null si no existe. */
const findDefaultBranch = async (db = pool) => {
  const r = await db.query(
    `SELECT id, code, name FROM branches
     WHERE is_active = TRUE
     ORDER BY (code = 'HQ') DESC, created_at ASC
     LIMIT 1`,
  );
  return r.rows[0] || null;
};

// ── Business days ──────────────────────────────────────────────────────────

const findByDateAndBranch = async (businessDate, branchId, db = pool) => {
  const r = await db.query(
    `SELECT id, business_date, branch_id, status,
            opened_at, ready_to_close_at, closed_at, closed_by,
            audited_at, audited_by, observations
     FROM business_days
     WHERE business_date = $1::date AND branch_id = $2`,
    [businessDate, branchId],
  );
  return r.rows[0] || null;
};

const findById = async (id, db = pool) => {
  const r = await db.query(
    `SELECT id, business_date, branch_id, status,
            opened_at, ready_to_close_at, closed_at, closed_by,
            audited_at, audited_by, observations
     FROM business_days
     WHERE id = $1`,
    [id],
  );
  return r.rows[0] || null;
};

const lockAndGetById = async (client, id) => {
  const r = await client.query(
    `SELECT id, business_date, branch_id, status,
            opened_at, ready_to_close_at, closed_at, audited_at
     FROM business_days
     WHERE id = $1
     FOR UPDATE`,
    [id],
  );
  return r.rows[0] || null;
};

/**
 * Crea una jornada para (fecha, sucursal). Si ya existe (race) la unique
 * constraint blinda la duplicación: el caller debe recuperar la existente.
 */
const create = async (client, { businessDate, branchId }) => {
  const r = await client.query(
    `INSERT INTO business_days (business_date, branch_id)
     VALUES ($1::date, $2)
     RETURNING id, business_date, branch_id, status, opened_at`,
    [businessDate, branchId],
  );
  return r.rows[0];
};

/**
 * Cuenta cajas por estado en una jornada (para decidir transiciones).
 */
const countSessionsByStatus = async (businessDayId, db = pool) => {
  const r = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'OPEN')::int                   AS open_count,
       COUNT(*) FILTER (WHERE status = 'PENDING_RECONCILIATION')::int AS pending_count,
       COUNT(*) FILTER (WHERE status = 'CLOSED')::int                 AS closed_count,
       COUNT(*)::int                                                   AS total_count
     FROM cash_sessions
     WHERE business_day_id = $1`,
    [businessDayId],
  );
  return r.rows[0];
};

/**
 * Transición automática OPEN → READY_TO_CLOSE cuando todas las cajas de la
 * jornada están en CLOSED (las PENDING bloquean — son deuda operativa).
 * Idempotente: si ya está en READY_TO_CLOSE/CLOSED/AUDITED no hace nada.
 *
 * Devuelve { transitioned: boolean, status: <nuevo o actual> }.
 */
const maybeTransitionToReadyToClose = async (client, businessDayId) => {
  const day = await lockAndGetById(client, businessDayId);
  if (!day) return { transitioned: false, status: null };
  if (day.status !== 'OPEN') return { transitioned: false, status: day.status };

  const counts = await countSessionsByStatus(businessDayId, client);
  // Necesita al menos una caja y NINGUNA OPEN ni PENDING.
  if (counts.total_count === 0) return { transitioned: false, status: day.status };
  if (counts.open_count > 0 || counts.pending_count > 0)
    return { transitioned: false, status: day.status };

  const r = await client.query(
    `UPDATE business_days
     SET status = 'READY_TO_CLOSE',
         ready_to_close_at = NOW()
     WHERE id = $1 AND status = 'OPEN'
     RETURNING status`,
    [businessDayId],
  );
  return { transitioned: r.rowCount === 1, status: r.rows[0]?.status ?? day.status };
};

/**
 * IMP-5: force-close (OPEN o READY_TO_CLOSE) → CLOSED. Permite cerrar una
 * jornada que tiene cajas PENDING_RECONCILIATION (no avanzaría a READY_TO_CLOSE
 * sola). Las cajas PENDING quedan como deuda operativa, registradas en
 * observations vía el caller.
 */
const forceClose = async (client, id, { closedBy, observations }) => {
  const r = await client.query(
    `UPDATE business_days
     SET status = 'CLOSED',
         closed_at = NOW(),
         closed_by = $2,
         ready_to_close_at = COALESCE(ready_to_close_at, NOW()),
         observations = COALESCE($3, observations)
     WHERE id = $1 AND status IN ('OPEN','READY_TO_CLOSE')
     RETURNING id, status, closed_at, closed_by`,
    [id, closedBy, observations || null],
  );
  return r.rows[0] || null;
};

/** READY_TO_CLOSE → CLOSED (supervisor). */
const close = async (client, id, { closedBy, observations }) => {
  const r = await client.query(
    `UPDATE business_days
     SET status = 'CLOSED',
         closed_at = NOW(),
         closed_by = $2,
         observations = COALESCE($3, observations)
     WHERE id = $1 AND status = 'READY_TO_CLOSE'
     RETURNING id, status, closed_at, closed_by`,
    [id, closedBy, observations || null],
  );
  return r.rows[0] || null;
};

/** CLOSED → AUDITED (auditor). */
const audit = async (client, id, { auditedBy, observations }) => {
  const r = await client.query(
    `UPDATE business_days
     SET status = 'AUDITED',
         audited_at = NOW(),
         audited_by = $2,
         observations = COALESCE($3, observations)
     WHERE id = $1 AND status = 'CLOSED'
     RETURNING id, status, audited_at, audited_by`,
    [id, auditedBy, observations || null],
  );
  return r.rows[0] || null;
};

const findAll = async ({ status, branchId, dateFrom, dateTo } = {}) => {
  let q = `
    SELECT bd.id, bd.business_date, bd.branch_id, b.code AS branch_code, b.name AS branch_name,
           bd.status, bd.opened_at, bd.ready_to_close_at, bd.closed_at, bd.audited_at,
           bd.observations
    FROM business_days bd
    JOIN branches b ON b.id = bd.branch_id
    WHERE 1=1`;
  const params = [];
  if (status)   { params.push(status);   q += ` AND bd.status = $${params.length}`; }
  if (branchId) { params.push(branchId); q += ` AND bd.branch_id = $${params.length}`; }
  if (dateFrom) { params.push(dateFrom); q += ` AND bd.business_date >= $${params.length}::date`; }
  if (dateTo)   { params.push(dateTo);   q += ` AND bd.business_date <= $${params.length}::date`; }
  q += ` ORDER BY bd.business_date DESC, b.code`;
  return (await pool.query(q, params)).rows;
};

module.exports = {
  findActiveBranchById,
  findDefaultBranch,
  findByDateAndBranch,
  findById,
  lockAndGetById,
  create,
  countSessionsByStatus,
  maybeTransitionToReadyToClose,
  forceClose,
  close,
  audit,
  findAll,
};
