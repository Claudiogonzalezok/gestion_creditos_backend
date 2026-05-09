const pool = require("../../config/db");

/**
 * Resumen de cuenta del cliente:
 * - deuda total vigente
 * - conteo de cuotas por estado
 * - próximos vencimientos (30 días)
 * - resumen de créditos (activos, liquidados, total cuotas)
 */
const getAccountSummary = async (customerId) => {
  // Totales de cuotas
  const totals = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN i.status IN ('PENDING','OVERDUE','PARTIAL')
                    THEN i.amount_due - i.amount_paid ELSE 0 END), 0) AS total_owed,
       COUNT(*) FILTER (WHERE i.status = 'PAID')                       AS paid_count,
       COUNT(*) FILTER (WHERE i.status IN ('PENDING','PARTIAL'))        AS pending_count,
       COUNT(*) FILTER (WHERE i.status = 'OVERDUE')                    AS overdue_count,
       COALESCE(SUM(i.amount_paid) FILTER (WHERE i.status = 'PAID'), 0) AS total_paid_amount,
       COALESCE(SUM(i.penalty_amount) FILTER (WHERE i.status = 'OVERDUE'), 0) AS pending_penalty_amount
     FROM installments i
     JOIN credits c ON c.id = i.credit_id
     WHERE c.customer_id = $1
       AND c.status IN ('ACTIVE','SETTLED')`,
    [customerId],
  );

  // Próximos vencimientos (30 días), solo cuotas pendientes o vencidas
  const upcoming = await pool.query(
    `SELECT
       i.id, i.installment_number, i.due_date,
       i.amount_due::float8, i.amount_paid::float8, i.penalty_amount::float8, i.status,
       c.id AS credit_id, c.type AS credit_type,
       c.installments_count AS credit_installments_count
     FROM installments i
     JOIN credits c ON c.id = i.credit_id
     WHERE c.customer_id = $1
       AND c.status = 'ACTIVE'
       AND i.status IN ('PENDING','OVERDUE','PARTIAL')
       AND i.due_date <= CURRENT_DATE + INTERVAL '30 days'
     ORDER BY i.due_date ASC`,
    [customerId],
  );

  // Resumen de créditos del cliente
  const creditsSummary = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'ACTIVE')  AS active_credits,
       COUNT(*) FILTER (WHERE status = 'SETTLED') AS settled_credits,
       COALESCE(SUM(installments_count), 0)::int  AS total_installments_count
     FROM credits
     WHERE customer_id = $1
       AND status IN ('ACTIVE','SETTLED')`,
    [customerId],
  );

  return {
    totals: totals.rows[0],
    upcoming: upcoming.rows,
    creditsSummary: creditsSummary.rows[0],
  };
};

/**
 * Lista de créditos visibles para el cliente (excluye PENDING_APPROVAL, REJECTED, EXPIRED).
 */
const findCredits = async (customerId) => {
  const r = await pool.query(
    `SELECT
       c.id, c.type, c.total_amount::float8, c.installments_count::int,
       c.payment_frequency, c.status, c.created_at, c.approved_at, c.settled_at,
       COUNT(i.id)::int                                              AS total_installments,
       COUNT(i.id) FILTER (WHERE i.status = 'PAID')::int            AS paid_installments,
       -- Próxima cuota: fecha y monto corresponden a la MISMA cuota (la más próxima a vencer).
       -- Se usan subqueries correlacionadas para garantizar que ambos valores sean de la misma fila.
       (SELECT i2.due_date FROM installments i2
        WHERE i2.credit_id = c.id AND i2.status IN ('PENDING','OVERDUE','PARTIAL')
        ORDER BY i2.due_date ASC LIMIT 1)                           AS next_due_date,
       (SELECT i2.amount_due::float8 FROM installments i2
        WHERE i2.credit_id = c.id AND i2.status IN ('PENDING','OVERDUE','PARTIAL')
        ORDER BY i2.due_date ASC LIMIT 1)                           AS next_due_amount,
       COALESCE(SUM(i.amount_due), 0)::float8               AS total_to_return,
       COALESCE(SUM(i.penalty_amount) FILTER (WHERE i.status = 'OVERDUE'), 0)::float8
                                                            AS pending_penalty,
       BOOL_OR(i.status = 'OVERDUE')                        AS has_overdue,
       -- Monto de cuota estándar: el de la primera cuota generada (número 1).
       (SELECT i3.amount_due::float8 FROM installments i3
        WHERE i3.credit_id = c.id
        ORDER BY i3.installment_number ASC LIMIT 1)                 AS installment_amount,
       (SELECT STRING_AGG(DISTINCT p.title, ' + ')
        FROM credit_products cp
        JOIN product_units pu ON pu.id = cp.product_unit_id
        JOIN product_variants pv ON pv.id = pu.variant_id
        JOIN products p ON p.id = pv.product_id
        WHERE cp.credit_id = c.id
       )                                                     AS credit_name
     FROM credits c
     LEFT JOIN installments i ON i.credit_id = c.id
     WHERE c.customer_id = $1
       AND c.status IN ('ACTIVE','SETTLED')
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [customerId],
  );
  return r.rows;
};

/**
 * Detalle de un crédito con su cronograma completo de cuotas.
 * Solo retorna el crédito si pertenece al cliente autenticado.
 */
const findCreditById = async (creditId, customerId) => {
  const credit = await pool.query(
    `SELECT
       c.id, c.type, c.total_amount::float8, c.installments_count::int,
       c.payment_frequency, c.status, c.created_at, c.approved_at, c.settled_at,
       c.down_payment::float8, c.down_payment_method,
       c.prepaid_installments::int, c.interest_rate::float8,
       (SELECT STRING_AGG(DISTINCT p.title, ' + ')
        FROM credit_products cp
        JOIN product_units pu ON pu.id = cp.product_unit_id
        JOIN product_variants pv ON pv.id = pu.variant_id
        JOIN products p ON p.id = pv.product_id
        WHERE cp.credit_id = c.id
       ) AS credit_name
     FROM credits c
     WHERE c.id = $1
       AND c.customer_id = $2
       AND c.status IN ('ACTIVE','SETTLED')`,
    [creditId, customerId],
  );
  if (!credit.rows[0]) return null;

  const installments = await pool.query(
    `SELECT
       id, installment_number, due_date,
       amount_due::float8, amount_paid::float8, penalty_amount::float8, status
     FROM installments
     WHERE credit_id = $1
     ORDER BY installment_number ASC`,
    [creditId],
  );

  return { ...credit.rows[0], installments: installments.rows };
};

module.exports = { getAccountSummary, findCredits, findCreditById };
