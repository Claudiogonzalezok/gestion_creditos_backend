const pool = require("../../config/db");
const { IS_OVERDUE_DERIVED } = require("../../utils/installmentSql");
const { movementConceptCase } = require("../../utils/movementConcept");

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
       -- Neteo de reversiones (RESTAN, como en la caja) y desglose por
       -- amount_cash/amount_transfer en vez de FILTER por payment_method: así los
       -- cobros MIXTOS reparten bien su efectivo/transferencia (antes, con
       -- payment_method='MIXED', quedaban fuera de ambos y el desglose no sumaba
       -- el total). El conteo excluye reversiones.
       SELECT
         COALESCE(bd.business_date, p.approved_at::date)                               AS day,
         COALESCE(SUM(CASE WHEN p.is_reversal THEN -p.amount_received ELSE p.amount_received END), 0) AS total,
         COALESCE(SUM(CASE WHEN p.is_reversal THEN -p.amount_cash     ELSE p.amount_cash     END), 0) AS total_cash,
         COALESCE(SUM(CASE WHEN p.is_reversal THEN -p.amount_transfer ELSE p.amount_transfer END), 0) AS total_transfer,
         COUNT(*) FILTER (WHERE NOT p.is_reversal)::int                                AS installments_count,
         0::numeric                                                                     AS down_payments_total,
         0::int                                                                         AS down_payments_count
       FROM payments p
       LEFT JOIN cash_sessions cs ON cs.id = p.cash_session_id
       LEFT JOIN business_days bd ON bd.id = cs.business_day_id
       WHERE p.status = 'APPROVED'
         AND COALESCE(bd.business_date, p.approved_at::date) BETWEEN $1 AND $2
       GROUP BY COALESCE(bd.business_date, p.approved_at::date)

       UNION ALL

       -- Enganche + cuotas adelantadas históricas (PREPAID_INSTALLMENT), igual que
       -- la caja. Desglose por amount_cash/amount_transfer para soportar mixto.
       SELECT
         cdp.register_date                                                             AS day,
         COALESCE(SUM(cdp.amount), 0)                                                  AS total,
         COALESCE(SUM(cdp.amount_cash),     0)                                         AS total_cash,
         COALESCE(SUM(cdp.amount_transfer), 0)                                         AS total_transfer,
         0::int                                                                         AS installments_count,
         COALESCE(SUM(cdp.amount), 0)                                                  AS down_payments_total,
         COUNT(*)::int                                                                  AS down_payments_count
       FROM credit_down_payments cdp
       WHERE cdp.register_date BETWEEN $1 AND $2
         AND cdp.payment_type IN ('DOWN_PAYMENT', 'PREPAID_INSTALLMENT')
       GROUP BY cdp.register_date
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
  const daily = rows
    .filter((r) => r.result_type === "daily")
    .map((r) => r.data);
  const summary = rows.find((r) => r.result_type === "summary")?.data || {};

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
     WHERE c.status = 'ACTIVE' AND i.status NOT IN ('PAID','REFINANCED','PLAN_CHANGE_CANCELLED','WRITTEN_OFF')`,
  );

  const topCustomers = await pool.query(
    `SELECT
       cu.id                                                              AS customer_id,
       cu.full_name                                                       AS customer_name,
       cu.phone,
       u.full_name                                                        AS assigned_collector,
       COUNT(DISTINCT c.id)::int                                          AS active_credits,
       COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8            AS pending_balance,
       COUNT(i.id) FILTER (WHERE ${IS_OVERDUE_DERIVED("i", "$1")})::int   AS overdue_installments
     FROM customers cu
     JOIN credits c      ON c.customer_id = cu.id AND c.status = 'ACTIVE'
     JOIN installments i ON i.credit_id   = c.id  AND i.status NOT IN ('PAID','REFINANCED','PLAN_CHANGE_CANCELLED','WRITTEN_OFF')
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
     WHERE ${IS_OVERDUE_DERIVED("i", "$1")}`,
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
     WHERE ${IS_OVERDUE_DERIVED("i", "$1")}
     GROUP BY cu.id, cu.full_name, cu.phone, u.full_name
     ORDER BY total_overdue DESC`,
    [graceDays],
  );

  return { summary: summary.rows[0], by_customer: byCustomer.rows };
};

// ── 4. Reporte de cobradores ──────────────────────────────────

const getCollectorsReport = async (dateFrom, dateTo) => {
  const r = await pool.query(
    `WITH collector_payments AS (
       SELECT
         p.*,
         COALESCE(bd.business_date, p.approved_at::date) AS jornada_date
       FROM payments p
       LEFT JOIN cash_sessions cs ON cs.id = p.cash_session_id
       LEFT JOIN business_days bd ON bd.id = cs.business_day_id
     )
     SELECT
       u.id                                                                      AS collector_id,
       u.full_name                                                               AS collector_name,
       u.role,
       COUNT(p.id)::int                                                          AS total_payments,
       COUNT(p.id) FILTER (WHERE p.status = 'APPROVED')::int                    AS approved_count,
       COUNT(p.id) FILTER (WHERE p.status = 'REJECTED')::int                    AS rejected_count,
       COALESCE(SUM(p.amount_received) FILTER (
         WHERE p.status = 'APPROVED'
           AND NOT p.is_reversal
           AND NOT EXISTS (SELECT 1 FROM payments rev WHERE rev.reversed_by_payment_id = p.id)
       ), 0)::float8 AS total_collected,
       COALESCE(ROUND(
         COUNT(p.id) FILTER (WHERE p.status = 'APPROVED')::numeric /
         NULLIF(COUNT(p.id), 0) * 100, 2
       ), 0)::float8                                                             AS approval_rate,
       COALESCE(ROUND(
         AVG(EXTRACT(EPOCH FROM (p.approved_at - p.created_at)) / 3600)
         FILTER (WHERE p.status = 'APPROVED')::numeric, 2
       ), 0)::float8                                                             AS avg_approval_hours
     FROM users u
     LEFT JOIN collector_payments p
       ON p.collector_id = u.id
       AND p.status = 'APPROVED'
       AND p.jornada_date BETWEEN $1 AND $2
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
 * @param {number} graceDays - Días de gracia para considerar una cuota en mora.
 * @param {string} jornadaDate - Fecha de la jornada comercial activa (YYYY-MM-DD).
 * @returns {Promise<object>} Métricas diarias clave del negocio.
 */
const getSummaryReport = async (graceDays, jornadaDate) => {
  const r = await pool.query(
    `WITH
     today_payments AS (
       -- Neteo de reversiones: un cobro reversado (is_reversal=TRUE) es dinero que
       -- salió de la caja, por lo que RESTA de lo recaudado — misma lógica que
       -- computeSessionTotals. Sin esto, una reversión se sumaba como si fuera un
       -- ingreso y "Recaudado hoy" quedaba inflado. El conteo de cobros excluye las
       -- reversiones (no son cobros nuevos).
       SELECT
         COALESCE(SUM(CASE WHEN p.is_reversal THEN -p.amount_received ELSE p.amount_received END), 0)::float8 AS collected,
         COALESCE(SUM(CASE WHEN p.is_reversal THEN -p.amount_cash     ELSE p.amount_cash     END), 0)::float8 AS cash,
         COALESCE(SUM(CASE WHEN p.is_reversal THEN -p.amount_transfer ELSE p.amount_transfer END), 0)::float8 AS transfer,
         COUNT(*) FILTER (WHERE NOT p.is_reversal)::int                                  AS count
       FROM payments p
       LEFT JOIN cash_sessions cs ON cs.id = p.cash_session_id
       LEFT JOIN business_days bd ON bd.id = cs.business_day_id
       WHERE p.status = 'APPROVED'
         AND COALESCE(bd.business_date, p.approved_at::date) = $2
     ),
      -- Incluye PREPAID_INSTALLMENT además de DOWN_PAYMENT, igual que la caja
      -- (computeSessionTotals). Las cuotas adelantadas NUEVAS ya no generan filas
      -- en credit_down_payments (van a payments), así que esto solo recupera los
      -- registros históricos y no hay doble conteo.
      today_down_payments AS (
        SELECT
          COALESCE(SUM(amount), 0)::float8 AS total,
          COALESCE(SUM(amount_cash),     0)::float8 AS cash,
          COALESCE(SUM(amount_transfer), 0)::float8 AS transfer,
          COUNT(*)::int                    AS count
        FROM credit_down_payments
        WHERE register_date = $2
          AND payment_type IN ('DOWN_PAYMENT', 'PREPAID_INSTALLMENT')
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
       WHERE c.status = 'ACTIVE' AND i.status NOT IN ('PAID','REFINANCED','PLAN_CHANGE_CANCELLED','WRITTEN_OFF')
     ),
     overdue AS (
       SELECT
         COUNT(*)::int                                         AS count,
         COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8 AS amount
       FROM installments i
       WHERE ${IS_OVERDUE_DERIVED("i", "$1")}
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
       $2::date                              AS report_date,
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
    [graceDays, jornadaDate],
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

/**
 * Obtiene el reporte de movimientos de caja (cobros, enganches, gastos,
 * drops y conversiones) imputados a una caja operativa puntual.
 * @param {string} cashSessionId - ID de la caja operativa (cash_sessions.id).
 * @returns {Promise<object>} Resumen agregado y detalle de movimientos.
 */
const getCashMovementsReport = async (cashSessionId) => {
  const result = await pool.query(
    `WITH movements AS (
       SELECT p.id, 'COBRO' AS type, p.approved_at AS occurred_at,
               p.cash_session_id, p.amount_received::float8 AS amount,
               p.payment_method,
               ${movementConceptCase("p", "cr")} AS description,
               u.full_name AS performed_by_name,
               p.transfer_reference,
               c.id AS customer_id, c.full_name AS customer_name, c.dni AS customer_dni,
               cr.id AS credit_id, cr.type::text AS credit_type, i.id AS installment_id,
               i.installment_number, NULL::uuid AS expense_category_id,
               NULL::text AS expense_category_name, NULL::text AS expense_source,
               NULL::text AS drop_destination, NULL::text AS drop_reason,
               NULL::text AS drop_status, NULL::text AS receipt_reference,
               NULL::text AS conversion_source_method, NULL::text AS conversion_target_method,
               NULL::text AS conversion_criteria,
               prod.product_summary
          FROM payments p
          JOIN installments i ON i.id = p.installment_id
          JOIN credits cr ON cr.id = i.credit_id
          JOIN customers c ON c.id = cr.customer_id
          LEFT JOIN users u ON u.id = p.approved_by
          LEFT JOIN LATERAL (
            SELECT string_agg(pr.title || COALESCE(' · ' || pu.unit_code, ''), ', ' ORDER BY pr.title, pu.unit_code) AS product_summary
              FROM credit_products cp
              JOIN product_units pu ON pu.id = cp.product_unit_id
              JOIN product_variants pv ON pv.id = pu.variant_id
              JOIN products pr ON pr.id = pv.product_id
             WHERE cp.credit_id = cr.id
          ) prod ON TRUE
         WHERE p.status = 'APPROVED' AND p.cash_session_id IS NOT NULL

       UNION ALL

        SELECT dp.id, 'ENGANCHE' AS type, dp.created_at AS occurred_at,
               dp.cash_session_id, dp.amount::float8 AS amount,
               dp.payment_method,
               'Enganche · ' || c.full_name AS description,
               u.full_name AS performed_by_name,
               dp.transfer_reference,
               c.id AS customer_id, c.full_name AS customer_name, c.dni AS customer_dni,
               cr.id AS credit_id, cr.type::text AS credit_type, NULL::uuid AS installment_id,
               NULL::int AS installment_number, NULL::uuid AS expense_category_id,
               NULL::text AS expense_category_name, NULL::text AS expense_source,
               NULL::text AS drop_destination, NULL::text AS drop_reason,
               NULL::text AS drop_status, NULL::text AS receipt_reference,
               NULL::text AS conversion_source_method, NULL::text AS conversion_target_method,
               NULL::text AS conversion_criteria,
               prod.product_summary
          FROM credit_down_payments dp
          JOIN credits cr ON cr.id = dp.credit_id
          JOIN customers c ON c.id = cr.customer_id
          LEFT JOIN users u ON u.id = dp.approved_by
          LEFT JOIN LATERAL (
            SELECT string_agg(pr.title || COALESCE(' · ' || pu.unit_code, ''), ', ' ORDER BY pr.title, pu.unit_code) AS product_summary
              FROM credit_products cp
              JOIN product_units pu ON pu.id = cp.product_unit_id
              JOIN product_variants pv ON pv.id = pu.variant_id
              JOIN products pr ON pr.id = pv.product_id
             WHERE cp.credit_id = cr.id
          ) prod ON TRUE
         WHERE dp.cash_session_id IS NOT NULL

       UNION ALL

        SELECT e.id, 'GASTO' AS type, e.created_at AS occurred_at,
               e.cash_session_id, e.amount::float8 AS amount,
               e.payment_method, e.description,
               u.full_name AS performed_by_name,
               e.transfer_reference,
               NULL::uuid AS customer_id, NULL::text AS customer_name, NULL::text AS customer_dni,
               NULL::uuid AS credit_id, NULL::text AS credit_type, NULL::uuid AS installment_id,
               NULL::int AS installment_number, ec.id AS expense_category_id,
               ec.name AS expense_category_name, e.source AS expense_source,
               NULL::text AS drop_destination, NULL::text AS drop_reason,
               NULL::text AS drop_status, NULL::text AS receipt_reference,
               NULL::text AS conversion_source_method, NULL::text AS conversion_target_method,
               NULL::text AS conversion_criteria,
               NULL::text AS product_summary
          FROM expenses e
          LEFT JOIN users u ON u.id = e.created_by
          LEFT JOIN expense_categories ec ON ec.id = e.category_id
         WHERE e.cash_session_id IS NOT NULL

       UNION ALL

        SELECT d.id, 'DROP' AS type, d.performed_at AS occurred_at,
               d.cash_session_id, d.amount::float8 AS amount,
               d.payment_method,
               'Drop a ' || d.destination
                 || COALESCE(' · ' || d.reason, '')
                 || CASE WHEN d.status = 'REVERSED' THEN ' (revertido)' ELSE '' END AS description,
               u.full_name AS performed_by_name,
               NULL::text AS transfer_reference,
               NULL::uuid AS customer_id, NULL::text AS customer_name, NULL::text AS customer_dni,
               NULL::uuid AS credit_id, NULL::text AS credit_type, NULL::uuid AS installment_id,
               NULL::int AS installment_number, NULL::uuid AS expense_category_id,
               NULL::text AS expense_category_name, NULL::text AS expense_source,
               d.destination AS drop_destination, d.reason AS drop_reason,
               d.status AS drop_status, d.receipt_reference,
               NULL::text AS conversion_source_method, NULL::text AS conversion_target_method,
               NULL::text AS conversion_criteria,
               NULL::text AS product_summary
          FROM cash_session_drops d
          LEFT JOIN users u ON u.id = d.performed_by

       UNION ALL

        SELECT cv.id, 'CONVERSION' AS type, cv.created_at AS occurred_at,
               cv.cash_session_id, cv.amount::float8 AS amount,
               cv.source_method || '_' || cv.target_method AS payment_method,
               COALESCE(cv.notes, 'Conversión ' || cv.source_method || ' → ' || cv.target_method) AS description,
               u.full_name AS performed_by_name,
               NULL::text AS transfer_reference,
               NULL::uuid AS customer_id, NULL::text AS customer_name, NULL::text AS customer_dni,
               NULL::uuid AS credit_id, NULL::text AS credit_type, NULL::uuid AS installment_id,
               NULL::int AS installment_number, NULL::uuid AS expense_category_id,
               NULL::text AS expense_category_name, NULL::text AS expense_source,
               NULL::text AS drop_destination, NULL::text AS drop_reason,
               NULL::text AS drop_status, NULL::text AS receipt_reference,
               cv.source_method AS conversion_source_method, cv.target_method AS conversion_target_method,
               cv.criteria AS conversion_criteria,
               NULL::text AS product_summary
          FROM cash_conversions cv
          LEFT JOIN users u ON u.id = cv.created_by
         WHERE cv.cash_session_id IS NOT NULL
     )
     SELECT m.id, m.type, m.occurred_at, m.cash_session_id,
            bd.business_date::text AS business_date, b.name AS branch_name,
             cs.shift_label, m.amount, m.payment_method, m.description,
             m.performed_by_name, m.transfer_reference, m.customer_id,
             m.customer_name, m.customer_dni, m.credit_id, m.credit_type,
             m.installment_id, m.installment_number, m.expense_category_id,
             m.expense_category_name, m.expense_source, m.drop_destination,
             m.drop_reason, m.drop_status, m.receipt_reference,
             m.conversion_source_method, m.conversion_target_method,
             m.conversion_criteria, m.product_summary
       FROM movements m
       JOIN cash_sessions cs ON cs.id = m.cash_session_id
       JOIN business_days bd ON bd.id = cs.business_day_id
       JOIN branches b ON b.id = bd.branch_id
      WHERE cs.id = $1
      ORDER BY m.occurred_at DESC`,
    [cashSessionId],
  );

  const rows = result.rows;
  const sumByType = (type) =>
    rows.filter((r) => r.type === type).reduce((acc, r) => acc + r.amount, 0);

  return {
    summary: {
      total_movements: rows.length,
      total_collections: sumByType("COBRO"),
      total_down_payments: sumByType("ENGANCHE"),
      total_expenses: sumByType("GASTO"),
      total_drops: sumByType("DROP"),
    },
    rows,
  };
};

/**
 * Reporte de movimientos de Caja General (tesorería): ledger completo de
 * `cash_account_movements`, independiente de cualquier jornada/caja operativa.
 * Cubre gastos/conversiones COMPANY e ingresos manuales (MANUAL_INCOME), que
 * no aparecen en `getCashMovementsReport` (scoped a cash_session_id).
 * @param {string} dateFrom - Fecha inicial del rango.
 * @param {string} dateTo - Fecha final del rango.
 * @returns {Promise<object>} Resumen agregado y detalle de movimientos.
 */
const getGeneralCashMovementsReport = async (dateFrom, dateTo) => {
  const summaryResult = await pool.query(
    `SELECT
       COUNT(*)::int AS total_movements,
       COALESCE(SUM(m.amount) FILTER (WHERE m.direction = 'IN'), 0)::float8 AS total_in,
       COALESCE(SUM(m.amount) FILTER (WHERE m.direction = 'OUT'), 0)::float8 AS total_out
     FROM cash_account_movements m
     JOIN cash_accounts ca ON ca.id = m.cash_account_id AND ca.type = 'GENERAL_CASH'
     WHERE m.created_at::date BETWEEN $1::date AND $2::date`,
    [dateFrom, dateTo],
  );

  const detailResult = await pool.query(
    `SELECT
       m.id, m.movement_type, m.direction,
       m.amount::float8 AS amount,
       m.amount_cash::float8 AS amount_cash,
       m.amount_transfer::float8 AS amount_transfer,
       m.description, m.beneficiary_name,
       m.reference_type, m.reference_id, m.created_at,
       u.full_name AS performed_by_name
     FROM cash_account_movements m
     JOIN cash_accounts ca ON ca.id = m.cash_account_id AND ca.type = 'GENERAL_CASH'
     LEFT JOIN users u ON u.id = m.created_by
     WHERE m.created_at::date BETWEEN $1::date AND $2::date
     ORDER BY m.created_at DESC`,
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
  getCashMovementsReport,
  getCashConversionsReport,
  getGeneralCashMovementsReport,
};
