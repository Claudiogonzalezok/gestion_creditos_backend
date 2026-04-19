const pool = require('../../config/db');

// Total recaudado en efectivo del día (cobros aprobados + enganches en efectivo)
const getDailyCashTotal = async (date) => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM (
       SELECT amount_received AS amount
       FROM payments
       WHERE status = 'APPROVED' AND payment_method = 'CASH'
         AND approved_at::date = $1::date
       UNION ALL
       SELECT amount
       FROM credit_down_payments
       WHERE payment_method = 'CASH'
         AND created_at::date = $1::date
     ) combined`,
    [date]
  );
  return parseFloat(r.rows[0].total);
};

// Total recaudado por transferencia del día (cobros aprobados + enganches por transferencia)
const getDailyTransferTotal = async (date) => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM (
       SELECT amount_received AS amount
       FROM payments
       WHERE status = 'APPROVED' AND payment_method = 'TRANSFER'
         AND approved_at::date = $1::date
       UNION ALL
       SELECT amount
       FROM credit_down_payments
       WHERE payment_method = 'TRANSFER'
         AND created_at::date = $1::date
     ) combined`,
    [date]
  );
  return parseFloat(r.rows[0].total);
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
    SELECT cr.id, cr.register_date, cr.total_collected, cr.cash_amount,
           cr.transfer_amount, cr.declared_cash, cr.difference,
           cr.difference_status, cr.observations, cr.created_at,
           u.full_name AS closed_by_name
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
    `SELECT cr.id, cr.register_date, cr.total_collected, cr.cash_amount,
            cr.transfer_amount, cr.declared_cash, cr.difference,
            cr.difference_status, cr.observations, cr.created_at,
            u.full_name AS closed_by_name
     FROM cash_registers cr
     JOIN users u ON u.id = cr.closed_by
     WHERE cr.id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

const create = async (client, {
  registerDate, cashAmount, transferAmount, totalCollected,
  totalEgreses, declaredCash, difference, differenceStatus, observations, closedBy,
}) => {
  const r = await client.query(
    `INSERT INTO cash_registers
       (register_date, cash_amount, transfer_amount, total_collected,
        total_egreses, declared_cash, difference, difference_status, observations, closed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, register_date, total_collected, total_egreses, cash_amount, transfer_amount,
               declared_cash, difference, difference_status, observations, created_at`,
    [
      registerDate, cashAmount, transferAmount, totalCollected,
      totalEgreses, declaredCash, difference, differenceStatus, observations || null, closedBy,
    ]
  );
  return r.rows[0];
};

// Total de egresos del día (liquidaciones de sueldos y comisiones)
const getDailyEgresesTotal = async (date) => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(total_paid), 0) AS total
     FROM commission_liquidations
     WHERE paid_at::date = $1::date`,
    [date]
  );
  return parseFloat(r.rows[0].total);
};

// Vincula las liquidaciones del día al cierre de caja recién creado
const linkLiquidations = async (client, cashRegisterId, date) => {
  await client.query(
    `UPDATE commission_liquidations
     SET cash_register_id = $1
     WHERE paid_at::date = $2::date
       AND cash_register_id IS NULL`,
    [cashRegisterId, date]
  );
};

// Dashboard del día actual (incluye enganches en los totales)
const getDashboard = async (date) => {
  // Cobros de cuotas (aprobados y pendientes)
  const payments = await pool.query(
    `SELECT
       COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'CASH'    AND p.status = 'APPROVED'), 0) AS cash_amount,
       COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'TRANSFER' AND p.status = 'APPROVED'), 0) AS transfer_amount,
       COALESCE(SUM(p.amount_received) FILTER (WHERE p.status = 'APPROVED'),                                   0) AS total_collected,
       COUNT(*) FILTER (WHERE p.status = 'APPROVED')                                                              AS approved_count,
       COUNT(*) FILTER (WHERE p.status = 'PENDING')                                                               AS pending_count
     FROM payments p
     WHERE (p.status = 'APPROVED' AND p.approved_at::date = $1::date)
        OR (p.status = 'PENDING'  AND p.created_at::date  = $1::date)`,
    [date]
  );

  // Enganches del día (siempre aprobados al momento de registrarse)
  const downPayments = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE payment_method = 'CASH'),     0) AS cash_amount,
       COALESCE(SUM(amount) FILTER (WHERE payment_method = 'TRANSFER'), 0) AS transfer_amount,
       COALESCE(SUM(amount),                                            0) AS total,
       COUNT(*)                                                             AS count
     FROM credit_down_payments
     WHERE created_at::date = $1::date`,
    [date]
  );

  const p  = payments.rows[0];
  const dp = downPayments.rows[0];

  return {
    cash_amount:          parseFloat(p.cash_amount)     + parseFloat(dp.cash_amount),
    transfer_amount:      parseFloat(p.transfer_amount) + parseFloat(dp.transfer_amount),
    total_collected:      parseFloat(p.total_collected) + parseFloat(dp.total),
    approved_count:       parseInt(p.approved_count),
    pending_count:        parseInt(p.pending_count),
    // Enganches desglosados por separado para visibilidad en el dashboard
    down_payments_total:  parseFloat(dp.total),
    down_payments_count:  parseInt(dp.count),
  };
};

module.exports = {
  getDailyCashTotal, getDailyTransferTotal, getDailyEgresesTotal,
  findByDate, findAll, findById, create, linkLiquidations, getDashboard,
};
