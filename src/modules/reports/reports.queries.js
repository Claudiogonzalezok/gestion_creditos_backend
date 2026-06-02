const pool = require("../../config/db");
const { IS_OVERDUE_DERIVED } = require("../../utils/installmentSql");

// ── 1. Reporte de recaudación ─────────────────────────────────

/**
 * Genera el reporte de recaudación consolidando cuotas cobradas y enganches aprobados.
 * Solo toma DOWN_PAYMENT para no mezclar otros ingresos internos de créditos.
 * @param {string} dateFrom - Fecha inicial del rango.
 * @param {string} dateTo - Fecha final del rango.
 * @returns {Promise<object>} Resumen y detalle diario de recaudación.
 */
const getCollectionReport = async (dateFrom, dateTo) => {
  const result = await pool.query(
    `WITH collection_data AS (
       SELECT
         p.approved_at::date                                                            AS day,
         COALESCE(SUM(p.amount_received), 0)                                           AS total,
         COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'CASH'),     0) AS total_cash,
         COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'TRANSFER'), 0) AS total_transfer,
         COUNT(*)::int                                                                  AS installments_count,
         0::numeric                                                                     AS down_payments_total,
         0::int                                                                         AS down_payments_count
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
         0::int                                                                         AS installments_count,
         COALESCE(SUM(cdp.amount), 0)                                                  AS down_payments_total,
         COUNT(*)::int                                                                  AS down_payments_count
       FROM credit_down_payments cdp
       WHERE cdp.created_at::date BETWEEN $1 AND $2
         AND cdp.payment_type = 'DOWN_PAYMENT'
       GROUP BY cdp.created_at::date
     ),
     daily_aggregated AS (
       SELECT
         day,
         SUM(total)::float8               AS total,
         SUM(total_cash)::float8          AS total_cash,
         SUM(total_transfer)::float8      AS total_transfer,
         SUM(installments_count)::int     AS installments_count,
         SUM(down_payments_total)::float8 AS down_payments_total,
         SUM(down_payments_count)::int    AS down_payments_count
       FROM collection_data
       GROUP BY day
       ORDER BY day
     )
     SELECT
       'daily' AS result_type,
       row_number() OVER (ORDER BY day)::text AS row_order,
       to_jsonb(d) AS data
     FROM daily_aggregated d

     UNION ALL

     SELECT
       'summary' AS result_type,
       '0' AS row_order,
       jsonb_build_object(
         'grand_total', COALESCE(SUM(total), 0),
         'total_cash', COALESCE(SUM(total_cash), 0),
         'total_transfer', COALESCE(SUM(total_transfer), 0),
         'installments_count', COALESCE(SUM(installments_count), 0),
         'down_payments_total', COALESCE(SUM(down_payments_total), 0),
         'down_payments_count', COALESCE(SUM(down_payments_count), 0)
       ) AS data
     FROM daily_aggregated`,
    [dateFrom, dateTo],
  );

  const rows = result.rows;
  const daily = rows.filter(r => r.result_type === 'daily').map(r => r.data);
  const summary = rows.find(r => r.result_type === 'summary')?.data || {};

  return { summary, daily };
};

// ── 2. Reporte de cartera ─────────────────────────────────────

const getPortfolioReport = async (graceDays) => {
  const byStatusType = await pool.query(
    `SELECT
       c.status,
       c.type,
       COUNT(*)::int                          AS count,
       COALESCE(SUM(c.total_amount), 0)::float8 AS total_amount
     FROM credits c
     GROUP BY c.status, c.type
     ORDER BY c.status, c.type`,
  );

  const activeBalance = await pool.query(
    `SELECT COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8 AS pending_balance
     FROM installments i
     JOIN credits c ON c.id = i.credit_id
     WHERE c.status = 'ACTIVE' AND i.status NOT IN ('PAID','REFINANCED')`,
  );

  const topCustomers = await pool.query(
    `SELECT
       cu.id                                                              AS customer_id,
       cu.full_name                                                       AS customer_name,
       cu.phone,
       u.full_name                                                        AS assigned_collector,
       COUNT(DISTINCT c.id)::int                                          AS active_credits,
       COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8            AS pending_balance,
       COUNT(i.id) FILTER (WHERE ${IS_OVERDUE_DERIVED('i', '$1')})::int   AS overdue_installments
     FROM customers cu
     JOIN credits c      ON c.customer_id = cu.id AND c.status = 'ACTIVE'
     JOIN installments i ON i.credit_id   = c.id  AND i.status NOT IN ('PAID','REFINANCED')
     LEFT JOIN users u   ON u.id = cu.assigned_collector_id
     GROUP BY cu.id, cu.full_name, cu.phone, u.full_name
     ORDER BY pending_balance DESC
     LIMIT 10`,
    [graceDays],
  );

  return {
    by_status_type: byStatusType.rows,
    active_pending_balance: activeBalance.rows[0].pending_balance,
    top_customers: topCustomers.rows,
  };
};

// ── 3. Reporte de mora ────────────────────────────────────────

const getOverdueReport = async (graceDays) => {
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
     WHERE ${IS_OVERDUE_DERIVED('i', '$1')}`,
    [graceDays],
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
     WHERE ${IS_OVERDUE_DERIVED('i', '$1')}
     GROUP BY cu.id, cu.full_name, cu.phone, u.full_name
     ORDER BY total_overdue DESC`,
    [graceDays],
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
       AND p.approved_at::date BETWEEN $1 AND $2
       AND p.status = 'APPROVED'
     WHERE u.role IN ('COLLECTOR','SELLER_COLLECTOR','ADMIN') AND u.status = 'ACTIVE'
     GROUP BY u.id, u.full_name, u.role
     ORDER BY total_collected DESC`,
    [dateFrom, dateTo],
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
    [stockThreshold],
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
    [n],
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
    [n],
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
    [n],
  );

  return {
    days: n,
    summary: summary.rows[0],
    by_day: byDay.rows,
    by_customer: byCustomer.rows,
  };
};

// ── 7. Resumen ejecutivo del día ──────────────────────────────

/**
 * Devuelve un resumen ejecutivo del día para el panel administrativo.
 * Suma los enganches reales del día junto con la cobranza aprobada.
 * @returns {Promise<object>} Métricas diarias clave del negocio.
 */
const getSummaryReport = async (graceDays) => {
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
          COALESCE(SUM(amount) FILTER (WHERE payment_method = 'CASH'),     0)::float8 AS cash,
          COALESCE(SUM(amount) FILTER (WHERE payment_method = 'TRANSFER'), 0)::float8 AS transfer,
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
       WHERE c.status = 'ACTIVE' AND i.status NOT IN ('PAID','REFINANCED')
     ),
     overdue AS (
       SELECT
         COUNT(*)::int                                         AS count,
         COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8 AS amount
       FROM installments i
       WHERE ${IS_OVERDUE_DERIVED('i', '$1')}
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
     ),
     active_credits AS (
       SELECT COUNT(*)::int AS count
       FROM credits
       WHERE status = 'ACTIVE'
     ),
     refinanced_month AS (
       SELECT
         COUNT(*)::int                                AS count,
         COALESCE(SUM(total_amount), 0)::float8       AS amount
       FROM credits
       WHERE refinanced_from_credit_id IS NOT NULL
         AND created_at >= date_trunc('month', CURRENT_DATE)
         AND created_at <  date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
     )
     SELECT
       CURRENT_DATE                          AS report_date,
       tp.collected                          AS today_collected,
       (tp.cash + tdp.cash)                  AS today_cash,
       (tp.transfer + tdp.transfer)          AS today_transfer,
       tp.count                              AS today_payments_count,
       tdp.total                             AS today_down_payments,
       tdp.count                             AS today_down_payments_count,
       (tp.collected + tdp.total)            AS today_total,
       pp.count                              AS pending_payments_count,
       pc.count                              AS pending_credits_count,
       po.balance                            AS active_portfolio_balance,
       ac.count                              AS active_credits_count,
       ov.count                              AS overdue_count,
       ov.amount                             AS overdue_amount,
       up.count                              AS upcoming_7d_count,
       up.amount                             AS upcoming_7d_amount,
       rm.count                              AS refinanced_month_count,
       rm.amount                             AS refinanced_month_amount
     FROM today_payments tp,
          today_down_payments tdp,
          pending_payments pp,
          pending_credits pc,
          portfolio po,
          active_credits ac,
          overdue ov,
          upcoming up,
          refinanced_month rm`,
    [graceDays],
  );
  return r.rows[0];
};

// ── 8. Reporte de vendedores ────────────────────────────────

/**
 * Obtiene el reporte de vendedores agrupando por créditos creados en el rango de fechas.
 * Incluye roles SELLER, SELLER_COLLECTOR y ADMIN.
 * @param {string} dateFrom - Fecha inicial del rango.
 * @param {string} dateTo - Fecha final del rango.
 * @returns {Promise<array>} Lista de vendedores con estadísticas de créditos creados.
 */
const getSellersReport = async (dateFrom, dateTo) => {
  const r = await pool.query(
    `SELECT
       u.id                                                                      AS seller_id,
       u.full_name                                                               AS seller_name,
       u.role,
       COUNT(c.id)::int                                                          AS total_credits,
       COALESCE(SUM(c.total_amount), 0)::float8                                 AS total_amount
     FROM users u
     LEFT JOIN credits c
       ON c.created_by = u.id
       AND c.created_at::date BETWEEN $1 AND $2
     WHERE u.role IN ('SELLER','SELLER_COLLECTOR','ADMIN') AND u.status = 'ACTIVE'
     GROUP BY u.id, u.full_name, u.role
     ORDER BY total_amount DESC`,
    [dateFrom, dateTo],
  );
  return r.rows;
};

// ── 9. Alertas: Pagos pendientes vencidos (>48h) ────────────────

/**
 * Obtiene los pagos pendientes que tienen más de 48 horas sin aprobar.
 * Filtra en el backend para reducir la transferencia de datos.
 * @returns {Promise<array>} Lista de pagos pendientes con >48 horas.
 */
const getPaymentsOverdue48h = async () => {
  // payments NO tiene customer_id: hay que llegar a customers vía
  // installments → credits. Además excluimos reversiones (no son cobros
  // pendientes reales).
  const r = await pool.query(
    `SELECT
       p.id,
       cu.id                                              AS customer_id,
       cu.full_name                                       AS customer_name,
       p.amount_received::float8,
       p.payment_method,
       p.created_at,
       EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600 AS hours_pending
     FROM payments p
     JOIN installments i ON i.id  = p.installment_id
     JOIN credits     c  ON c.id  = i.credit_id
     JOIN customers   cu ON cu.id = c.customer_id
     WHERE p.status      = 'PENDING'
       AND p.is_reversal = FALSE
       AND NOW() - p.created_at > INTERVAL '48 hours'
     ORDER BY p.created_at ASC`,
  );
  return r.rows;
};

/**
 * Obtiene el reporte de conversiones de caja por rango de fechas.
 * @param {string} dateFrom - Fecha inicial del rango.
 * @param {string} dateTo - Fecha final del rango.
 * @returns {Promise<object>} Resumen y detalle diario de conversiones.
 */
const getCashConversionsReport = async (dateFrom, dateTo) => {
  const summaryResult = await pool.query(
    `SELECT
       COUNT(*)::int AS total_conversions,
       COALESCE(SUM(amount), 0)::float8 AS total_amount,
       COALESCE(SUM(amount) FILTER (WHERE source_method = 'CASH'), 0)::float8 AS cash_to_transfer,
       COALESCE(SUM(amount) FILTER (WHERE source_method = 'TRANSFER'), 0)::float8 AS transfer_to_cash
     FROM cash_conversions
     WHERE register_date BETWEEN $1::date AND $2::date`,
    [dateFrom, dateTo],
  );

  const detailResult = await pool.query(
    `SELECT
       cc.id,
       cc.register_date::text,
       cc.criteria,
       cc.source_method,
       cc.target_method,
       cc.amount::float8,
       cc.notes,
       cc.created_at,
       u.full_name AS created_by_name
     FROM cash_conversions cc
     JOIN users u ON u.id = cc.created_by
     WHERE cc.register_date BETWEEN $1::date AND $2::date
     ORDER BY cc.register_date DESC, cc.created_at DESC`,
    [dateFrom, dateTo],
  );

  return {
    summary: summaryResult.rows[0],
    rows: detailResult.rows,
  };
};

module.exports = {
  getCollectionReport,
  getPortfolioReport,
  getOverdueReport,
  getCollectorsReport,
  getProductsReport,
  getUpcomingReport,
  getSummaryReport,
  getSellersReport,
  getPaymentsOverdue48h,
  getCashConversionsReport,
};
