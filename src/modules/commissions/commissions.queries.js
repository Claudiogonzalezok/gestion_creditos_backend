const pool = require('../../config/db');
const { getWeekBounds } = require('../../utils/creditCalculator');

// ── Comisiones ────────────────────────────────────────────────

const findCommissions = async ({ userId, status, weekStart } = {}) => {
  let q = `
    SELECT cm.id, cm.user_id, cm.credit_id, cm.amount::float8, cm.status,
           cm.week_start, cm.week_end, cm.created_at,
           u.full_name AS user_name, u.role AS user_role,
           c.type AS credit_type, c.total_amount::float8 AS credit_amount,
           cu.full_name AS customer_name
    FROM commissions cm
    JOIN users u      ON u.id  = cm.user_id
    JOIN credits c    ON c.id  = cm.credit_id
    JOIN customers cu ON cu.id = c.customer_id
    WHERE 1=1`;
  const params = [];
  if (userId)    { params.push(userId);    q += ` AND cm.user_id = $${params.length}`; }
  if (status)    { params.push(status);    q += ` AND cm.status = $${params.length}`; }
  if (weekStart) { params.push(weekStart); q += ` AND cm.week_start = $${params.length}`; }
  q += ` ORDER BY cm.created_at DESC`;
  return (await pool.query(q, params)).rows;
};

// Suma neto de todas las comisiones pendientes de un usuario (sin filtro de semana)
const getPendingTotal = async (userId) => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float8 AS total
     FROM commissions
     WHERE user_id = $1 AND status = 'PENDING'`,
    [userId]
  );
  return r.rows[0].total;
};

// IDs, montos y rango de semanas de todas las comisiones pendientes de un usuario.
// FOR UPDATE bloquea las filas para evitar doble liquidación en requests concurrentes.
const getPendingIds = async (client, userId) => {
  const r = await client.query(
    `SELECT id, amount::float8, week_start, week_end FROM commissions
     WHERE user_id = $1 AND status = 'PENDING'
     FOR UPDATE`,
    [userId]
  );
  return r.rows;
};

const markCommissionsPaid = async (client, ids) => {
  if (!ids.length) return;
  await client.query(
    `UPDATE commissions SET status = 'PAID' WHERE id = ANY($1::uuid[])`,
    [ids]
  );
};

// Sueldo fijo activo del usuario
const findSalary = async (userId) => {
  const r = await pool.query(
    `SELECT id, user_id, weekly_amount::float8 FROM salaries WHERE user_id = $1 AND active = true`,
    [userId]
  );
  return r.rows[0] || null;
};

const createSalary = async (userId, weeklyAmount) => {
  const r = await pool.query(
    `INSERT INTO salaries (user_id, weekly_amount)
     VALUES ($1, $2)
     RETURNING id, user_id, weekly_amount::float8, active`,
    [userId, weeklyAmount]
  );
  return r.rows[0];
};

const updateSalary = async (id, weeklyAmount) => {
  const r = await pool.query(
    `UPDATE salaries SET weekly_amount = $1 WHERE id = $2
     RETURNING id, user_id, weekly_amount::float8, active`,
    [weeklyAmount, id]
  );
  return r.rows[0];
};

// ── Liquidaciones ─────────────────────────────────────────────

const createLiquidation = async (client, {
  userId, weekStart, weekEnd,
  commissionsTotal, salaryAmount, totalPaid,
  paymentMethod, transferReference, paidBy,
}) => {
  const r = await client.query(
    `INSERT INTO commission_liquidations
       (user_id, week_start, week_end, commissions_total, salary_amount,
        total_paid, payment_method, transfer_reference, paid_by, paid_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     RETURNING id, user_id, week_start, week_end,
               commissions_total::float8, salary_amount::float8, total_paid::float8,
               payment_method, transfer_reference, paid_by, paid_at`,
    [
      userId, weekStart, weekEnd,
      commissionsTotal, salaryAmount, totalPaid,
      paymentMethod, transferReference || null, paidBy,
    ]
  );
  return r.rows[0];
};

const findLiquidations = async ({ userId } = {}) => {
  let q = `
    SELECT cl.id, cl.user_id, cl.week_start, cl.week_end,
           cl.commissions_total::float8, cl.salary_amount::float8, cl.total_paid::float8,
           cl.payment_method, cl.transfer_reference, cl.paid_by, cl.paid_at,
           u.full_name AS user_name, adm.full_name AS paid_by_name
    FROM commission_liquidations cl
    JOIN users u   ON u.id  = cl.user_id
    JOIN users adm ON adm.id = cl.paid_by
    WHERE 1=1`;
  const params = [];
  if (userId) { params.push(userId); q += ` AND cl.user_id = $${params.length}`; }
  q += ` ORDER BY cl.paid_at DESC`;
  return (await pool.query(q, params)).rows;
};

// Resumen de lo pendiente de liquidar para cada usuario activo.
// Muestra todas las comisiones PENDING (puede abarcar varios ciclos si no se liquidó el lunes anterior).
const getWeeklySummary = async () => {
  const r = await pool.query(
    `SELECT
       u.id AS user_id,
       u.full_name,
       u.role,
       COALESCE(SUM(cm.amount), 0)::float8          AS commissions_total,
       MIN(cm.week_start)                            AS earliest_week,
       MAX(cm.week_end)                              AS latest_week,
       COALESCE(s.weekly_amount, 0)::float8          AS salary_amount
     FROM users u
     LEFT JOIN commissions cm ON cm.user_id = u.id AND cm.status = 'PENDING'
     LEFT JOIN salaries s     ON s.user_id  = u.id AND s.active = true
     WHERE u.status = 'ACTIVE'
       AND u.role IN ('SELLER','COLLECTOR','SELLER_COLLECTOR')
       AND (cm.id IS NOT NULL OR s.id IS NOT NULL)
     GROUP BY u.id, u.full_name, u.role, s.weekly_amount
     ORDER BY u.full_name`
  );
  return r.rows.map(row => ({
    ...row,
    total_net: row.commissions_total + row.salary_amount,
  }));
};

module.exports = {
  findCommissions, getPendingTotal, getPendingIds, markCommissionsPaid,
  findSalary, createSalary, updateSalary,
  createLiquidation, findLiquidations, getWeeklySummary,
};
