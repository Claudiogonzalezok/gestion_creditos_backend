const pool = require('../../config/db');

// Total recaudado en efectivo del día (cobros aprobados)
const getDailyCashTotal = async (date) => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(p.amount_received), 0) AS total
     FROM payments p
     WHERE p.status = 'APPROVED'
       AND p.payment_method = 'CASH'
       AND p.approved_at::date = $1::date`,
    [date]
  );
  return parseFloat(r.rows[0].total);
};

// Total recaudado por transferencia del día
const getDailyTransferTotal = async (date) => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(p.amount_received), 0) AS total
     FROM payments p
     WHERE p.status = 'APPROVED'
       AND p.payment_method = 'TRANSFER'
       AND p.approved_at::date = $1::date`,
    [date]
  );
  return parseFloat(r.rows[0].total);
};

// Cobros pendientes de aprobación
const getPendingPaymentsCount = async () => {
  const r = await pool.query(
    `SELECT COUNT(*) FROM payments WHERE status = 'PENDING'`
  );
  return parseInt(r.rows[0].count);
};

// Verifica si ya existe un cierre para la fecha
const findByDate = async (date) => {
  const r = await pool.query(
    `SELECT id FROM cash_registers WHERE register_date::date = $1::date`,
    [date]
  );
  return r.rows[0] || null;
};

const findAll = async ({ dateFrom, dateTo } = {}) => {
  let q = `
    SELECT cr.*, u.full_name AS closed_by_name
    FROM cash_registers cr
    JOIN users u ON u.id = cr.closed_by
    WHERE 1=1`;
  const params = [];
  if (dateFrom) { params.push(dateFrom); q += ` AND cr.register_date >= $${params.length}`; }
  if (dateTo)   { params.push(dateTo);   q += ` AND cr.register_date <= $${params.length}`; }
  q += ` ORDER BY cr.register_date DESC`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT cr.*, u.full_name AS closed_by_name
     FROM cash_registers cr
     JOIN users u ON u.id = cr.closed_by
     WHERE cr.id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

const create = async ({
  registerDate, totalCash, totalTransfer, totalApproved,
  declaredCash, cashDifference, status,
  pendingPaymentsCount, observations, closedBy,
}) => {
  const r = await pool.query(
    `INSERT INTO cash_registers
       (register_date, total_cash, total_transfer, total_approved,
        declared_cash, cash_difference, status,
        pending_payments_count, observations, closed_by, closed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     RETURNING *`,
    [
      registerDate, totalCash, totalTransfer, totalApproved,
      declaredCash, cashDifference, status,
      pendingPaymentsCount, observations || null, closedBy,
    ]
  );
  return r.rows[0];
};

// Dashboard del día actual
const getDashboard = async (date) => {
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'CASH'),       0) AS total_cash,
       COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'TRANSFER'),    0) AS total_transfer,
       COALESCE(SUM(p.amount_received), 0)                                                 AS total_approved,
       COUNT(*) FILTER (WHERE p.status = 'APPROVED')                                       AS approved_count,
       COUNT(*) FILTER (WHERE p.status = 'PENDING')                                        AS pending_count
     FROM payments p
     WHERE p.approved_at::date = $1::date OR (p.status = 'PENDING' AND p.created_at::date = $1::date)`,
    [date]
  );
  return r.rows[0];
};

module.exports = {
  getDailyCashTotal, getDailyTransferTotal, getPendingPaymentsCount,
  findByDate, findAll, findById, create, getDashboard,
};
