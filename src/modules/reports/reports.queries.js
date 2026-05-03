const pool = require('../../config/db');

// ── 1. Reporte de recaudación ─────────────────────────────────

/**
 * Genera el reporte de recaudación consolidando cuotas cobradas y enganches aprobados.
 * Solo toma DOWN_PAYMENT para no mezclar otros ingresos internos de créditos.
 * @param {string} dateFrom - Fecha inicial del rango.
 * @param {string} dateTo - Fecha final del rango.
 * @returns {Promise<object>} Resumen y detalle diario de recaudación.
 */
const getCollectionReport = async (dateFrom, dateTo) => {
  const daily = await pool.query(
    `SELECT
       day,
       SUM(total)::float8               AS total,
       SUM(total_cash)::float8           AS total_cash,
       SUM(total_transfer)::float8       AS total_transfer,
       SUM(installments_count)::int      AS installments_count,
       SUM(down_payments_total)::float8  AS down_payments_total,
       SUM(down_payments_count)::int     AS down_payments_count
     FROM (
       SELECT
         p.approved_at::date                                                            AS day,
         COALESCE(SUM(p.amount_received), 0)                                           AS total,
         COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'CASH'),     0) AS total_cash,
         COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'TRANSFER'), 0) AS total_transfer,
         COUNT(*)                                                                       AS installments_count,
         0::numeric                                                                     AS down_payments_total,
         0                                                                              AS down_payments_count
       FROM payments p
       WHERE p.status = 'APPROVED'
         AND p.approved_at::date BETWEEN $1 AND $2
       GROUP BY p.approved_at::date

       UNION ALL

       SELECT
         cdp.created_at::date                                                           AS day,
         COALESCE(SUM(cdp.amount), 0)                                                  AS total,
         COALESCE(SUM(cdp.amount) FILTER (WHERE cdp.payment_method = 'CASH'),     0)   AS total_cash,
         COALESCE(SUM(cdp.amount) FILTER (WHERE cdp.payment_method = 'TRANSFER'), 0)   AS total_transfer,
         0                                                                              AS installments_count,
         COALESCE(SUM(cdp.amount), 0)                                                  AS down_payments_total,
         COUNT(*)                                                                       AS down_payments_count
        FROM credit_down_payments cdp
        WHERE cdp.created_at::date BETWEEN $1 AND $2
          AND cdp.payment_type = 'DOWN_PAYMENT'
        GROUP BY cdp.created_at::date
      ) sub
     GROUP BY day
     ORDER BY day`,
    [dateFrom, dateTo]
  );

  const summary = await pool.query(
    `SELECT
       SUM(total)::float8               AS grand_total,
       SUM(total_cash)::float8           AS total_cash,
       SUM(total_transfer)::float8       AS total_transfer,
       SUM(installments_count)::int      AS installments_count,
       SUM(down_payments_total)::float8  AS down_payments_total,
       SUM(down_payments_count)::int     AS down_payments_count
     FROM (
       SELECT
         COALESCE(SUM(p.amount_received), 0)                                           AS total,
         COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'CASH'),     0) AS total_cash,
         COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'TRANSFER'), 0) AS total_transfer,
         COUNT(*)                                                                       AS installments_count,
         0::numeric                                                                     AS down_payments_total,
         0                                                                              AS down_payments_count
       FROM payments p
       WHERE p.status = 'APPROVED'
         AND p.approved_at::date BETWEEN $1 AND $2

       UNION ALL

       SELECT
         COALESCE(SUM(cdp.amount), 0)                                                  AS total,
         COALESCE(SUM(cdp.amount) FILTER (WHERE cdp.payment_method = 'CASH'),     0)   AS total_cash,
         COALESCE(SUM(cdp.amount) FILTER (WHERE cdp.payment_method = 'TRANSFER'), 0)   AS total_transfer,
         0                                                                              AS installments_count,
         COALESCE(SUM(cdp.amount), 0)                                                  AS down_payments_total,
         COUNT(*)                                                                       AS down_payments_count
        FROM credit_down_payments cdp
        WHERE cdp.created_at::date BETWEEN $1 AND $2
          AND cdp.payment_type = 'DOWN_PAYMENT'
      ) sub`,
    [dateFrom, dateTo]
  );

  return { summary: summary.rows[0], daily: daily.rows };
};

// ── 2. Reporte de cartera ─────────────────────────────────────

const getPortfolioReport = async () => {
  const byStatusType = await pool.query(
    `SELECT
       c.status,
       c.type,
       COUNT(*)::int                          AS count,
       COALESCE(SUM(c.total_amount), 0)::float8 AS total_amount
     FROM credits c
     GROUP BY c.status, c.type
     ORDER BY c.status, c.type`
  );

  const activeBalance = await pool.query(
    `SELECT COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8 AS pending_balance
     FROM installments i
     JOIN credits c ON c.id = i.credit_id
     WHERE c.status = 'ACTIVE' AND i.status NOT IN ('PAID')`
  );

  const topCustomers = await pool.query(
    `SELECT
       cu.id                                                              AS customer_id,
       cu.full_name                                                       AS customer_name,
       cu.phone,
       u.full_name                                                        AS assigned_collector,
       COUNT(DISTINCT c.id)::int                                          AS active_credits,
       COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8            AS pending_balance,
       COUNT(i.id) FILTER (WHERE i.status = 'OVERDUE')::int              AS overdue_installments
     FROM customers cu
     JOIN credits c      ON c.customer_id = cu.id AND c.status = 'ACTIVE'
     JOIN installments i ON i.credit_id   = c.id  AND i.status NOT IN ('PAID')
     LEFT JOIN users u   ON u.id = cu.assigned_collector_id
     GROUP BY cu.id, cu.full_name, cu.phone, u.full_name
     ORDER BY pending_balance DESC
     LIMIT 10`
  );

  return {
    by_status_type:        byStatusType.rows,
    active_pending_balance: activeBalance.rows[0].pending_balance,
    top_customers:         topCustomers.rows,
  };
};

// ── 3. Reporte de mora ────────────────────────────────────────

const getOverdueReport = async () => {
  const summary = await pool.query(
    `SELECT
       COUNT(*)::int                                                                    AS overdue_installments,
       COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8                         AS total_overdue_amount,
       COALESCE(SUM(i.penalty_amount), 0)::float8                                      AS total_penalties,
       COALESCE(AVG(CURRENT_DATE - i.due_date)::int, 0)                               AS avg_days_overdue,
       COUNT(*)       FILTER (WHERE (CURRENT_DATE - i.due_date) BETWEEN 1  AND 30)::int AS bucket_1_30_count,
       COALESCE(SUM(i.amount_due - i.amount_paid)
                      FILTER (WHERE (CURRENT_DATE - i.due_date) BETWEEN 1  AND 30), 0)::float8 AS bucket_1_30_amount,
       COUNT(*)       FILTER (WHERE (CURRENT_DATE - i.due_date) BETWEEN 31 AND 60)::int AS bucket_31_60_count,
       COALESCE(SUM(i.amount_due - i.amount_paid)
                      FILTER (WHERE (CURRENT_DATE - i.due_date) BETWEEN 31 AND 60), 0)::float8 AS bucket_31_60_amount,
       COUNT(*)       FILTER (WHERE (CURRENT_DATE - i.due_date) BETWEEN 61 AND 90)::int AS bucket_61_90_count,
       COALESCE(SUM(i.amount_due - i.amount_paid)
                      FILTER (WHERE (CURRENT_DATE - i.due_date) BETWEEN 61 AND 90), 0)::float8 AS bucket_61_90_amount,
       COUNT(*)       FILTER (WHERE (CURRENT_DATE - i.due_date) > 90)::int              AS bucket_90plus_count,
       COALESCE(SUM(i.amount_due - i.amount_paid)
                      FILTER (WHERE (CURRENT_DATE - i.due_date) > 90), 0)::float8      AS bucket_90plus_amount
     FROM installments i
     WHERE i.status = 'OVERDUE'`
  );

  const byCustomer = await pool.query(
    `SELECT
       cu.id                                                       AS customer_id,
       cu.full_name                                                AS customer_name,
       cu.phone,
       u.full_name                                                 AS assigned_collector,
       COUNT(i.id)::int                                            AS overdue_count,
       COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8     AS total_overdue,
       COALESCE(SUM(i.penalty_amount), 0)::float8                  AS total_penalties,
       MAX(CURRENT_DATE - i.due_date)::int                         AS max_days_overdue,
       CASE
         WHEN MAX(CURRENT_DATE - i.due_date) > 90 THEN '+90 días'
         WHEN MAX(CURRENT_DATE - i.due_date) > 60 THEN '61-90 días'
         WHEN MAX(CURRENT_DATE - i.due_date) > 30 THEN '31-60 días'
         ELSE '1-30 días'
       END                                                         AS aging_bucket
     FROM installments i
     JOIN credits c    ON c.id  = i.credit_id
     JOIN customers cu ON cu.id = c.customer_id
     LEFT JOIN users u ON u.id  = cu.assigned_collector_id
     WHERE i.status = 'OVERDUE'
     GROUP BY cu.id, cu.full_name, cu.phone, u.full_name
     ORDER BY total_overdue DESC`
  );

  return { summary: summary.rows[0], by_customer: byCustomer.rows };
};

// ── 4. Reporte de cobradores ──────────────────────────────────

const getCollectorsReport = async (dateFrom, dateTo) => {
  const r = await pool.query(
    `SELECT
       u.id                                                                      AS collector_id,
       u.full_name                                                               AS collector_name,
       u.role,
       COUNT(p.id)::int                                                          AS total_payments,
       COUNT(p.id) FILTER (WHERE p.status = 'APPROVED')::int                    AS approved_count,
       COUNT(p.id) FILTER (WHERE p.status = 'REJECTED')::int                    AS rejected_count,
       COALESCE(SUM(p.amount_received) FILTER (WHERE p.status = 'APPROVED'), 0)::float8 AS total_collected,
       COALESCE(ROUND(
         COUNT(p.id) FILTER (WHERE p.status = 'APPROVED')::numeric /
         NULLIF(COUNT(p.id), 0) * 100, 2
       ), 0)::float8                                                             AS approval_rate,
       COALESCE(ROUND(
         AVG(EXTRACT(EPOCH FROM (p.approved_at - p.created_at)) / 3600)
         FILTER (WHERE p.status = 'APPROVED')::numeric, 2
       ), 0)::float8                                                             AS avg_approval_hours
     FROM users u
     LEFT JOIN payments p
       ON p.collector_id = u.id
       AND p.created_at::date BETWEEN $1 AND $2
     WHERE u.role IN ('COLLECTOR','SELLER_COLLECTOR') AND u.status = 'ACTIVE'
     GROUP BY u.id, u.full_name, u.role
     ORDER BY total_collected DESC`,
    [dateFrom, dateTo]
  );
  return r.rows;
};

// ── 5. Reporte de productos ───────────────────────────────────

const getProductsReport = async (stockThreshold = 5) => {
  const r = await pool.query(
    `SELECT
       p.id,
       p.description,
       p.title,
       p.status,
       COALESCE(MIN(pv.current_price), 0)::float8                      AS min_price,
       COALESCE(MAX(pv.current_price), 0)::float8                      AS max_price,
       COUNT(pu.id) FILTER (WHERE pu.status = 'AVAILABLE')::int        AS available_count,
       COUNT(pu.id) FILTER (WHERE pu.status = 'SOLD')::int             AS total_units_sold,
       COUNT(pu.id) FILTER (WHERE pu.status = 'AVAILABLE') <= $1       AS low_stock,
       COUNT(DISTINCT cp.id) FILTER (WHERE c.status IN ('ACTIVE','SETTLED'))::int AS times_sold,
       COALESCE(SUM(cp.historical_price) FILTER (WHERE c.status IN ('ACTIVE','SETTLED')), 0)::float8 AS total_revenue,
       COALESCE(ROUND(AVG(cp.historical_price) FILTER (WHERE c.status IN ('ACTIVE','SETTLED')), 2), 0)::float8 AS avg_selling_price,
       COUNT(pr.id) FILTER (WHERE pr.active = TRUE)::int               AS active_rates_count,
       COUNT(pr.id)::int                                                AS total_rates_count
     FROM products p
     LEFT JOIN product_variants pv ON pv.product_id = p.id
     LEFT JOIN product_units    pu ON pu.variant_id  = pv.id
     LEFT JOIN credit_products  cp ON cp.product_unit_id = pu.id
     LEFT JOIN credits          c  ON c.id = cp.credit_id
     LEFT JOIN product_rates    pr ON pr.product_id = p.id
     GROUP BY p.id, p.description, p.title, p.status
     ORDER BY times_sold DESC`,
    [stockThreshold]
  );
  return r.rows;
};

// ── 6. Reporte de vencimientos próximos ──────────────────────

const getUpcomingReport = async (days = 30) => {
  const n = parseInt(days);

  const summary = await pool.query(
    `SELECT
       COUNT(*)::int                                         AS installments_count,
       COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8 AS expected_amount
     FROM installments i
     JOIN credits c ON c.id = i.credit_id
     WHERE c.status = 'ACTIVE'
       AND i.status  = 'PENDING'
       AND i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 - 1)`,
    [n]
  );

  const byDay = await pool.query(
    `SELECT
       i.due_date,
       COUNT(*)::int                                           AS count,
       COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8 AS expected_amount
     FROM installments i
     JOIN credits c ON c.id = i.credit_id
     WHERE c.status = 'ACTIVE'
       AND i.status  = 'PENDING'
       AND i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 - 1)
     GROUP BY i.due_date
     ORDER BY i.due_date`,
    [n]
  );

  const byCustomer = await pool.query(
    `SELECT
       cu.id                                                   AS customer_id,
       cu.full_name                                            AS customer_name,
       cu.phone,
       u.full_name                                             AS assigned_collector,
       COUNT(i.id)::int                                        AS installments_count,
       COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8 AS expected_amount,
       MIN(i.due_date)                                         AS next_due_date
     FROM installments i
     JOIN credits c    ON c.id  = i.credit_id
     JOIN customers cu ON cu.id = c.customer_id
     LEFT JOIN users u ON u.id  = cu.assigned_collector_id
     WHERE c.status = 'ACTIVE'
       AND i.status  = 'PENDING'
       AND i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 - 1)
     GROUP BY cu.id, cu.full_name, cu.phone, u.full_name
     ORDER BY next_due_date, expected_amount DESC`,
    [n]
  );

  return {
    days:        n,
    summary:     summary.rows[0],
    by_day:      byDay.rows,
    by_customer: byCustomer.rows,
  };
};

// ── 7. Resumen ejecutivo del día ──────────────────────────────

/**
 * Devuelve un resumen ejecutivo del día para el panel administrativo.
 * Suma los enganches reales del día junto con la cobranza aprobada.
 * @returns {Promise<object>} Métricas diarias clave del negocio.
 */
const getSummaryReport = async () => {
  const r = await pool.query(
    `WITH
     today_payments AS (
       SELECT
         COALESCE(SUM(p.amount_received), 0)::float8                                     AS collected,
         COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'CASH'),     0)::float8 AS cash,
         COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'TRANSFER'), 0)::float8 AS transfer,
         COUNT(*)::int                                                                    AS count
       FROM payments p
       WHERE p.status = 'APPROVED' AND p.approved_at::date = CURRENT_DATE
     ),
      today_down_payments AS (
        SELECT
          COALESCE(SUM(amount), 0)::float8 AS total,
          COUNT(*)::int                    AS count
        FROM credit_down_payments
        WHERE created_at::date = CURRENT_DATE
          AND payment_type = 'DOWN_PAYMENT'
      ),
     pending_payments AS (
       SELECT COUNT(*)::int AS count FROM payments WHERE status = 'PENDING'
     ),
     pending_credits AS (
       SELECT COUNT(*)::int AS count FROM credits WHERE status = 'PENDING_APPROVAL'
     ),
     portfolio AS (
       SELECT COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8 AS balance
       FROM installments i
       JOIN credits c ON c.id = i.credit_id
       WHERE c.status = 'ACTIVE' AND i.status NOT IN ('PAID')
     ),
     overdue AS (
       SELECT
         COUNT(*)::int                                         AS count,
         COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8 AS amount
       FROM installments i
       WHERE i.status = 'OVERDUE'
     ),
     upcoming AS (
       SELECT
         COUNT(*)::int                                          AS count,
         COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8 AS amount
       FROM installments i
       JOIN credits c ON c.id = i.credit_id
       WHERE c.status = 'ACTIVE'
         AND i.status = 'PENDING'
         AND i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 6
     )
     SELECT
       CURRENT_DATE                          AS report_date,
       tp.collected                          AS today_collected,
       tp.cash                               AS today_cash,
       tp.transfer                           AS today_transfer,
       tp.count                              AS today_payments_count,
       tdp.total                             AS today_down_payments,
       tdp.count                             AS today_down_payments_count,
       (tp.collected + tdp.total)            AS today_total,
       pp.count                              AS pending_payments_count,
       pc.count                              AS pending_credits_count,
       po.balance                            AS active_portfolio_balance,
       ov.count                              AS overdue_count,
       ov.amount                             AS overdue_amount,
       up.count                              AS upcoming_7d_count,
       up.amount                             AS upcoming_7d_amount
     FROM today_payments tp,
          today_down_payments tdp,
          pending_payments pp,
          pending_credits pc,
          portfolio po,
          overdue ov,
          upcoming up`
  );
  return r.rows[0];
};

module.exports = {
  getCollectionReport,
  getPortfolioReport,
  getOverdueReport,
  getCollectorsReport,
  getProductsReport,
  getUpcomingReport,
  getSummaryReport,
};
