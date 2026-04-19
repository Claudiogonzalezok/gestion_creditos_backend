const pool = require('../../config/db');

// ── Reporte de recaudación ────────────────────────────────────
// Incluye cobros de cuotas aprobados y enganches (credit_down_payments).

const getCollectionReport = async (dateFrom, dateTo) => {
  const r = await pool.query(
    `SELECT
       day,
       SUM(total)               AS total,
       SUM(total_cash)          AS total_cash,
       SUM(total_transfer)      AS total_transfer,
       SUM(installments_count)  AS installments_count,
       SUM(down_payments_total) AS down_payments_total,
       SUM(down_payments_count) AS down_payments_count
     FROM (
       SELECT
         p.approved_at::date                                                        AS day,
         COALESCE(SUM(p.amount_received), 0)                                       AS total,
         COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'CASH'),     0) AS total_cash,
         COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'TRANSFER'), 0) AS total_transfer,
         COUNT(*)                                                                   AS installments_count,
         0::numeric                                                                 AS down_payments_total,
         0                                                                          AS down_payments_count
       FROM payments p
       WHERE p.status = 'APPROVED'
         AND p.approved_at::date BETWEEN $1 AND $2
       GROUP BY p.approved_at::date

       UNION ALL

       SELECT
         cdp.created_at::date                                                       AS day,
         COALESCE(SUM(cdp.amount), 0)                                              AS total,
         COALESCE(SUM(cdp.amount) FILTER (WHERE cdp.payment_method = 'CASH'),     0) AS total_cash,
         COALESCE(SUM(cdp.amount) FILTER (WHERE cdp.payment_method = 'TRANSFER'), 0) AS total_transfer,
         0                                                                          AS installments_count,
         COALESCE(SUM(cdp.amount), 0)                                              AS down_payments_total,
         COUNT(*)                                                                   AS down_payments_count
       FROM credit_down_payments cdp
       WHERE cdp.created_at::date BETWEEN $1 AND $2
       GROUP BY cdp.created_at::date
     ) sub
     GROUP BY day
     ORDER BY day`,
    [dateFrom, dateTo]
  );

  const summary = await pool.query(
    `SELECT
       SUM(total)                AS grand_total,
       SUM(total_cash)           AS total_cash,
       SUM(total_transfer)       AS total_transfer,
       SUM(installments_count)   AS installments_count,
       SUM(down_payments_total)  AS down_payments_total,
       SUM(down_payments_count)  AS down_payments_count
     FROM (
       SELECT
         COALESCE(SUM(p.amount_received), 0)                                       AS total,
         COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'CASH'),     0) AS total_cash,
         COALESCE(SUM(p.amount_received) FILTER (WHERE p.payment_method = 'TRANSFER'), 0) AS total_transfer,
         COUNT(*)                                                                   AS installments_count,
         0::numeric                                                                 AS down_payments_total,
         0                                                                          AS down_payments_count
       FROM payments p
       WHERE p.status = 'APPROVED'
         AND p.approved_at::date BETWEEN $1 AND $2

       UNION ALL

       SELECT
         COALESCE(SUM(cdp.amount), 0)                                              AS total,
         COALESCE(SUM(cdp.amount) FILTER (WHERE cdp.payment_method = 'CASH'),     0) AS total_cash,
         COALESCE(SUM(cdp.amount) FILTER (WHERE cdp.payment_method = 'TRANSFER'), 0) AS total_transfer,
         0                                                                          AS installments_count,
         COALESCE(SUM(cdp.amount), 0)                                              AS down_payments_total,
         COUNT(*)                                                                   AS down_payments_count
       FROM credit_down_payments cdp
       WHERE cdp.created_at::date BETWEEN $1 AND $2
     ) sub`,
    [dateFrom, dateTo]
  );

  return { summary: summary.rows[0], daily: r.rows };
};

// ── Reporte de cartera ────────────────────────────────────────

const getPortfolioReport = async () => {
  const r = await pool.query(
    `SELECT
       c.status,
       c.type,
       COUNT(*)                         AS count,
       COALESCE(SUM(c.total_amount), 0) AS total_amount
     FROM credits c
     GROUP BY c.status, c.type
     ORDER BY c.status, c.type`
  );
  const activeTotal = await pool.query(
    `SELECT COALESCE(SUM(i.amount_due - i.amount_paid), 0) AS pending_balance
     FROM installments i
     JOIN credits c ON c.id = i.credit_id
     WHERE c.status = 'ACTIVE' AND i.status NOT IN ('PAID')`
  );
  return { by_status_type: r.rows, active_pending_balance: activeTotal.rows[0].pending_balance };
};

// ── Reporte de mora ───────────────────────────────────────────

const getOverdueReport = async () => {
  const summary = await pool.query(
    `SELECT
       COUNT(*)                           AS overdue_installments,
       COALESCE(SUM(i.amount_due - i.amount_paid), 0) AS total_overdue_amount,
       COALESCE(SUM(i.penalty_amount), 0)             AS total_penalties,
       AVG(CURRENT_DATE - i.due_date::date)::int      AS avg_days_overdue
     FROM installments i
     WHERE i.status = 'OVERDUE'`
  );
  const byCustomer = await pool.query(
    `SELECT
       cu.id AS customer_id,
       cu.full_name AS customer_name,
       cu.phone,
       COUNT(i.id)                                      AS overdue_count,
       COALESCE(SUM(i.amount_due - i.amount_paid), 0)  AS total_overdue,
       COALESCE(SUM(i.penalty_amount), 0)               AS total_penalties,
       MAX(CURRENT_DATE - i.due_date::date)             AS max_days_overdue
     FROM installments i
     JOIN credits c    ON c.id  = i.credit_id
     JOIN customers cu ON cu.id = c.customer_id
     WHERE i.status = 'OVERDUE'
     GROUP BY cu.id, cu.full_name, cu.phone
     ORDER BY total_overdue DESC`
  );
  return { summary: summary.rows[0], by_customer: byCustomer.rows };
};

// ── Reporte de cobradores ────────────────────────────────────

const getCollectorsReport = async (dateFrom, dateTo) => {
  const r = await pool.query(
    `SELECT
       u.id AS collector_id,
       u.full_name AS collector_name,
       COUNT(p.id)                           AS total_payments,
       COUNT(p.id) FILTER (WHERE p.status = 'APPROVED')  AS approved_count,
       COUNT(p.id) FILTER (WHERE p.status = 'REJECTED')  AS rejected_count,
       COALESCE(SUM(p.amount_received) FILTER (WHERE p.status = 'APPROVED'), 0) AS total_collected,
       ROUND(
         COUNT(p.id) FILTER (WHERE p.status = 'APPROVED')::numeric /
         NULLIF(COUNT(p.id), 0) * 100, 2
       ) AS approval_rate
     FROM users u
     LEFT JOIN payments p
       ON p.collector_id = u.id
       AND p.created_at::date BETWEEN $1 AND $2
     WHERE u.role = 'COLLECTOR' AND u.status = 'ACTIVE'
     GROUP BY u.id, u.full_name
     ORDER BY total_collected DESC`,
    [dateFrom, dateTo]
  );
  return r.rows;
};

// ── Reporte de productos ──────────────────────────────────────

const getProductsReport = async () => {
  const r = await pool.query(
    `SELECT
       p.id,
       p.name,
       p.current_price,
       p.available_stock,
       p.status,
       COUNT(DISTINCT cp.id)                                                        AS times_sold,
       COALESCE(SUM(cp.quantity), 0)                                               AS total_units_sold,
       COALESCE(SUM(cp.quantity * cp.historical_price), 0)                         AS total_revenue,
       COUNT(pr.id) FILTER (WHERE pr.active = TRUE)                                AS active_rates_count,
       COUNT(pr.id)                                                                 AS total_rates_count
     FROM products p
     LEFT JOIN credit_products cp ON cp.product_id = p.id
     LEFT JOIN credits c          ON c.id = cp.credit_id AND c.status IN ('ACTIVE','SETTLED')
     LEFT JOIN product_rates pr   ON pr.product_id = p.id
     GROUP BY p.id, p.name, p.current_price, p.available_stock, p.status
     ORDER BY times_sold DESC`
  );
  return r.rows;
};

module.exports = {
  getCollectionReport, getPortfolioReport, getOverdueReport,
  getCollectorsReport, getProductsReport,
};
