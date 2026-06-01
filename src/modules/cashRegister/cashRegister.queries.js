const pool = require('../../config/db');

// ── Dashboard del día — única query con CTEs ──────────────────
/**
 * Obtiene el dashboard diario de caja sumando cobros aprobados y enganches.
 * Solo incorpora movimientos tipo DOWN_PAYMENT dentro del bloque de ventas.
 * @param {string} date - Fecha local del día a consultar.
 * @returns {Promise<object>} Resumen consolidado de caja.
 */
const getDashboard = async (date) => {
  const r = await pool.query(
    `WITH
     payments_data AS (
       SELECT
         COALESCE(SUM(amount_received) FILTER (WHERE payment_method = 'CASH'     AND status = 'APPROVED'), 0) AS cash_amount,
         COALESCE(SUM(amount_received) FILTER (WHERE payment_method = 'TRANSFER' AND status = 'APPROVED'), 0) AS transfer_amount,
         COALESCE(SUM(amount_received) FILTER (WHERE status = 'APPROVED'), 0)                                  AS total_collected,
         COALESCE(SUM(amount_received) FILTER (WHERE status = 'PENDING'),  0)                                  AS pending_amount,
         COUNT(*) FILTER (WHERE status = 'APPROVED')                                                           AS approved_count,
         COUNT(*) FILTER (WHERE status = 'PENDING')                                                            AS pending_count
       FROM payments
       WHERE (status = 'APPROVED' AND approved_at::date = $1::date)
          OR  (status = 'PENDING'  AND created_at::date = $1::date)
     ),
     down_payments_data AS (
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE payment_method = 'CASH'),     0) AS cash_amount,
          COALESCE(SUM(amount) FILTER (WHERE payment_method = 'TRANSFER'), 0) AS transfer_amount,
          COALESCE(SUM(amount), 0)                                             AS total,
          COUNT(*)                                                              AS count
        FROM credit_down_payments
        WHERE register_date = $1::date
          AND payment_type = 'DOWN_PAYMENT'
      ),
     egreses_data AS (
       SELECT COALESCE(SUM(total_paid), 0) AS total
       FROM commission_liquidations
       WHERE paid_at::date = $1::date
     ),
     expenses_data AS (
       SELECT
         COALESCE(SUM(amount) FILTER (WHERE payment_method = 'CASH'),     0) AS cash_amount,
         COALESCE(SUM(amount) FILTER (WHERE payment_method = 'TRANSFER'), 0) AS transfer_amount,
         COALESCE(SUM(amount), 0)                                             AS total,
         COUNT(*)                                                              AS count
       FROM expenses
       WHERE register_date = $1::date
     )
     SELECT
       (p.cash_amount     + dp.cash_amount)::float8         AS cash_amount,
       (p.transfer_amount + dp.transfer_amount)::float8     AS transfer_amount,
       (p.total_collected + dp.total)::float8               AS total_collected,
       (e.total + ex.total)::float8                         AS total_outflows,
       (p.total_collected + dp.total - e.total - ex.total)::float8 AS net_balance,
       p.approved_count::int                                AS approved_count,
       p.pending_count::int                                 AS pending_count,
       p.pending_amount::float8                             AS pending_amount,
       dp.total::float8                                     AS down_payments_total,
       dp.count::int                                        AS down_payments_count,
       ex.total::float8                                     AS expenses_total,
       ex.count::int                                        AS expenses_count
     FROM payments_data p, down_payments_data dp, egreses_data e, expenses_data ex`,
    [date]
  );
  return r.rows[0];
};

// ── Totales del día para el cierre — una sola query ───────────
/**
 * Calcula los totales diarios usados para el cierre de caja.
 * Devuelve ingresos brutos, egresos desglosados por método y saldos netos.
 * cash_amount_neto     = (cobros_efec + enganches_efec) - (gastos_efec + comisiones_efec)
 * transfer_amount_neto = (cobros_transf + enganches_transf) - (gastos_transf + comisiones_transf)
 * @param {string} date - Fecha local del cierre.
 * @returns {Promise<object>} Totales brutos, egresos y netos de efectivo y transferencia.
 */
const getDailyTotals = async (date) => {
  const r = await pool.query(
    `WITH
     payments_totals AS (
       SELECT
         COALESCE(SUM(amount_received) FILTER (WHERE payment_method = 'CASH'),     0) AS cash_amount,
         COALESCE(SUM(amount_received) FILTER (WHERE payment_method = 'TRANSFER'), 0) AS transfer_amount
       FROM payments
       WHERE status = 'APPROVED' AND approved_at::date = $1::date
     ),
     down_payment_totals AS (
       SELECT
         COALESCE(SUM(amount) FILTER (WHERE payment_method = 'CASH'),     0) AS cash_amount,
         COALESCE(SUM(amount) FILTER (WHERE payment_method = 'TRANSFER'), 0) AS transfer_amount
       FROM credit_down_payments
       WHERE register_date = $1::date
         AND payment_type = 'DOWN_PAYMENT'
     ),
     commissions_totals AS (
       SELECT
         COALESCE(SUM(total_paid) FILTER (WHERE payment_method = 'CASH'),     0) AS cash_amount,
         COALESCE(SUM(total_paid) FILTER (WHERE payment_method = 'TRANSFER'), 0) AS transfer_amount,
         COALESCE(SUM(total_paid), 0)                                             AS total
       FROM commission_liquidations
       WHERE paid_at::date = $1::date
     ),
     expenses_totals AS (
       SELECT
         COALESCE(SUM(amount) FILTER (WHERE payment_method = 'CASH'),     0) AS cash_amount,
         COALESCE(SUM(amount) FILTER (WHERE payment_method = 'TRANSFER'), 0) AS transfer_amount,
         COALESCE(SUM(amount), 0)                                             AS total
       FROM expenses
       WHERE register_date = $1::date
     )
     SELECT
       -- Ingresos brutos por método
       (p.cash_amount     + dp.cash_amount)::float8                                         AS gross_cash,
       (p.transfer_amount + dp.transfer_amount)::float8                                     AS gross_transfer,
       -- Egresos desglosados por método
       ex.cash_amount::float8                                                               AS expenses_cash,
       ex.transfer_amount::float8                                                           AS expenses_transfer,
       c.cash_amount::float8                                                                AS commissions_cash,
       c.transfer_amount::float8                                                            AS commissions_transfer,
       (ex.total + c.total)::float8                                                         AS total_outflows,
       -- Saldos netos por método (ingresos - egresos del mismo método)
       (p.cash_amount     + dp.cash_amount     - ex.cash_amount     - c.cash_amount)::float8     AS cash_amount,
       (p.transfer_amount + dp.transfer_amount - ex.transfer_amount - c.transfer_amount)::float8 AS transfer_amount
     FROM payments_totals p, down_payment_totals dp, commissions_totals c, expenses_totals ex`,
    [date]
  );
  return r.rows[0];
};

// ── Pre-cargas pendientes del día — bloquea el cierre ────────────────────────
const getPendingPaymentsToday = async (date) => {
  const r = await pool.query(
    `SELECT
       COUNT(*)::int                                    AS count,
       COALESCE(SUM(amount_received), 0)::float8        AS amount
     FROM payments
     WHERE status = 'PENDING'
       AND created_at::date = $1::date`,
    [date]
  );
  return r.rows[0];
};

// ── Resumen pre-cierre (solo lectura) ────────────────────────
/**
 * Devuelve el desglose completo del día para mostrar antes del cierre.
 * Reutiliza la misma lógica de getDailyTotals más el detalle de ingresos y pendientes.
 * @param {string} date - Fecha local 'YYYY-MM-DD'.
 * @returns {Promise<object>} Desglose de ingresos, egresos, saldos netos y pendientes.
 */
const getPreClose = async (date) => {
  const r = await pool.query(
    `WITH
     payments_totals AS (
       SELECT
         COALESCE(SUM(amount_received) FILTER (WHERE payment_method = 'CASH'),     0) AS cash_amount,
         COALESCE(SUM(amount_received) FILTER (WHERE payment_method = 'TRANSFER'), 0) AS transfer_amount
       FROM payments
       WHERE status = 'APPROVED' AND approved_at::date = $1::date
     ),
     down_payment_totals AS (
       SELECT
         COALESCE(SUM(amount) FILTER (WHERE payment_method = 'CASH'),     0) AS cash_amount,
         COALESCE(SUM(amount) FILTER (WHERE payment_method = 'TRANSFER'), 0) AS transfer_amount
       FROM credit_down_payments
       WHERE register_date = $1::date
         AND payment_type = 'DOWN_PAYMENT'
     ),
     commissions_totals AS (
       SELECT
         COALESCE(SUM(total_paid) FILTER (WHERE payment_method = 'CASH'),     0) AS cash_amount,
         COALESCE(SUM(total_paid) FILTER (WHERE payment_method = 'TRANSFER'), 0) AS transfer_amount
       FROM commission_liquidations
       WHERE paid_at::date = $1::date
     ),
     expenses_totals AS (
       SELECT
         COALESCE(SUM(amount) FILTER (WHERE payment_method = 'CASH'),     0) AS cash_amount,
         COALESCE(SUM(amount) FILTER (WHERE payment_method = 'TRANSFER'), 0) AS transfer_amount
       FROM expenses
       WHERE register_date = $1::date
     ),
     pending_totals AS (
       SELECT
         COUNT(*)::int                                   AS count,
         COALESCE(SUM(amount_received), 0)::float8       AS amount
       FROM payments
       WHERE status = 'PENDING'
         AND created_at::date = $1::date
     )
     SELECT
       p.cash_amount::float8                                                                     AS cobros_efectivo,
       p.transfer_amount::float8                                                                 AS cobros_transferencia,
       dp.cash_amount::float8                                                                    AS enganches_efectivo,
       dp.transfer_amount::float8                                                                AS enganches_transferencia,
       (p.cash_amount + p.transfer_amount + dp.cash_amount + dp.transfer_amount)::float8         AS total_bruto,
       ex.cash_amount::float8                                                                    AS gastos_efectivo,
       ex.transfer_amount::float8                                                                AS gastos_transferencia,
       c.cash_amount::float8                                                                     AS comisiones_efectivo,
       c.transfer_amount::float8                                                                 AS comisiones_transferencia,
       (ex.cash_amount + ex.transfer_amount + c.cash_amount + c.transfer_amount)::float8         AS total_egresos,
       (p.cash_amount + dp.cash_amount - ex.cash_amount - c.cash_amount)::float8                 AS efectivo_esperado,
       (p.transfer_amount + dp.transfer_amount - ex.transfer_amount - c.transfer_amount)::float8 AS transferencia_esperada,
       pt.count                                                                                  AS pendientes_count,
       pt.amount                                                                                 AS pendientes_amount
     FROM payments_totals p, down_payment_totals dp, commissions_totals c, expenses_totals ex, pending_totals pt`,
    [date]
  );
  return r.rows[0];
};

// ── Jornada comercial activa ──────────────────────────────────
/**
 * Busca la fecha más reciente con actividad financiera que no tiene cierre de caja.
 * Permite determinar la jornada comercial activa cuando se trabaja pasada la medianoche.
 * Busca hasta 14 días atrás desde la fecha de referencia.
 * @param {string} today - Fecha de referencia YYYY-MM-DD.
 * @returns {Promise<string|null>} Fecha YYYY-MM-DD de la jornada activa, o null si no hay actividad abierta.
 */
const findUnclosedJornadaDate = async (today) => {
  const r = await pool.query(
    `SELECT MAX(activity_date)::text AS jornada_date
     FROM (
       SELECT created_at::date AS activity_date
       FROM payments
       WHERE status != 'REJECTED'
         AND created_at::date BETWEEN ($1::date - INTERVAL '14 days') AND $1::date
       UNION ALL
       SELECT register_date
       FROM credit_down_payments
       WHERE payment_type = 'DOWN_PAYMENT'
         AND register_date BETWEEN ($1::date - INTERVAL '14 days') AND $1::date
       UNION ALL
       SELECT register_date
       FROM expenses
       WHERE register_date BETWEEN ($1::date - INTERVAL '14 days') AND $1::date
     ) t
     WHERE activity_date NOT IN (
       SELECT register_date::date
       FROM cash_registers
       WHERE register_date >= ($1::date - INTERVAL '14 days')
     )`,
    [today]
  );
  return r.rows[0]?.jornada_date || null;
};

// ── Verifica si ya existe un cierre para la fecha ─────────────
const findByDate = async (date) => {
  const r = await pool.query(
    `SELECT id FROM cash_registers WHERE register_date = $1::date`,
    [date]
  );
  return r.rows[0] || null;
};

// ── Historial de cierres ──────────────────────────────────────
const findAll = async ({ dateFrom, dateTo, differenceStatus } = {}) => {
  let q = `
    SELECT cr.id, cr.register_date,
           cr.total_collected::float8, cr.cash_amount::float8,
           cr.transfer_amount::float8, cr.total_outflows::float8,
           cr.declared_cash::float8, cr.difference::float8,
           cr.difference_status, cr.observations, cr.created_at,
           u.full_name AS closed_by_name
    FROM cash_registers cr
    JOIN users u ON u.id = cr.closed_by
    WHERE 1=1`;
  const params = [];
  if (dateFrom)         { params.push(dateFrom);         q += ` AND cr.register_date >= $${params.length}`; }
  if (dateTo)           { params.push(dateTo);           q += ` AND cr.register_date <= $${params.length}`; }
  if (differenceStatus) { params.push(differenceStatus); q += ` AND cr.difference_status = $${params.length}`; }
  q += ` ORDER BY cr.register_date DESC`;
  return (await pool.query(q, params)).rows;
};

// ── Detalle de un cierre con desglose completo ────────────────
const findById = async (id) => {
  const registerResult = await pool.query(
    `SELECT cr.id, cr.register_date,
            cr.total_collected::float8, cr.cash_amount::float8,
            cr.transfer_amount::float8, cr.total_outflows::float8,
            cr.declared_cash::float8, cr.difference::float8,
            cr.difference_status, cr.observations, cr.created_at,
            u.full_name AS closed_by_name
     FROM cash_registers cr
     JOIN users u ON u.id = cr.closed_by
     WHERE cr.id = $1`,
    [id]
  );

  const register = registerResult.rows[0];
  if (!register) return null;

  const [paymentsResult, downPaymentsResult, liquidationsResult, expensesResult] = await Promise.all([
    pool.query(
      `SELECT p.id, p.amount_received::float8, p.payment_method,
              p.transfer_reference, p.approved_at,
              cu.full_name          AS customer_name,
              u.full_name           AS collector_name,
              i.installment_number
       FROM payments p
       JOIN users u        ON u.id  = p.collector_id
       JOIN installments i ON i.id  = p.installment_id
       JOIN credits c      ON c.id  = i.credit_id
       JOIN customers cu   ON cu.id = c.customer_id
       WHERE p.status = 'APPROVED'
         AND p.approved_at::date = $1::date
       ORDER BY p.approved_at`,
      [register.register_date]
    ),
    pool.query(
      `SELECT cdp.id, cdp.amount::float8, cdp.payment_method,
              cdp.transfer_reference, cdp.payment_type, cdp.created_at,
              cu.full_name AS customer_name,
              u.full_name  AS approved_by_name
        FROM credit_down_payments cdp
        JOIN credits c    ON c.id  = cdp.credit_id
        JOIN customers cu ON cu.id = c.customer_id
        JOIN users u      ON u.id  = cdp.approved_by
        WHERE cdp.register_date = $1::date
          AND cdp.payment_type = 'DOWN_PAYMENT'
        ORDER BY cdp.created_at`,
      [register.register_date]
    ),
    pool.query(
      `SELECT cl.id, cl.total_paid::float8, cl.commissions_total::float8,
              cl.salary_amount::float8, cl.payment_method,
              cl.transfer_reference, cl.paid_at,
              u.full_name AS employee_name
       FROM commission_liquidations cl
       JOIN users u ON u.id = cl.user_id
       WHERE cl.cash_register_id = $1
       ORDER BY cl.paid_at`,
      [id]
    ),
    pool.query(
      `SELECT e.id, e.amount::float8, e.description, e.payment_method,
              e.transfer_reference, e.created_at,
              u.full_name AS created_by_name
       FROM expenses e
       JOIN users u ON u.id = e.created_by
       WHERE e.register_date = $1::date
       ORDER BY e.created_at`,
      [register.register_date]
    ),
  ]);

  return {
    ...register,
    breakdown: {
      payments:      paymentsResult.rows,
      down_payments: downPaymentsResult.rows,
      liquidations:  liquidationsResult.rows,
      expenses:      expensesResult.rows,
    },
  };
};

// ── Crear cierre ──────────────────────────────────────────────
const create = async (client, {
  registerDate, cashAmount, transferAmount, totalCollected,
  totalOutflows, declaredCash, difference, differenceStatus, observations, closedBy,
}) => {
  const r = await client.query(
    `INSERT INTO cash_registers
       (register_date, cash_amount, transfer_amount, total_collected,
        total_outflows, declared_cash, difference, difference_status, observations, closed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, register_date,
               total_collected::float8, total_outflows::float8,
               cash_amount::float8, transfer_amount::float8,
               declared_cash::float8, difference::float8,
               difference_status, observations, created_at`,
    [
      registerDate, cashAmount, transferAmount, totalCollected,
      totalOutflows, declaredCash, difference, differenceStatus, observations || null, closedBy,
    ]
  );
  return r.rows[0];
};

// ── Vincula liquidaciones del día al cierre recién creado ─────
const linkLiquidations = async (client, cashRegisterId, date) => {
  await client.query(
    `UPDATE commission_liquidations
     SET cash_register_id = $1
     WHERE paid_at::date = $2::date
       AND cash_register_id IS NULL`,
    [cashRegisterId, date]
  );
};

module.exports = {
  getDashboard,
  getDailyTotals,
  getPreClose,
  getPendingPaymentsToday,
  findByDate,
  findUnclosedJornadaDate,
  findAll,
  findById,
  create,
  linkLiquidations,
};
