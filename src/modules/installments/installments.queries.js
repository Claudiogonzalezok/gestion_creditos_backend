const pool = require('../../config/db');

const findAll = async ({ credit_id, status, collector_id } = {}) => {
  let q = `
    SELECT i.id, i.credit_id, i.installment_number, i.due_date, i.original_due_date,
           i.amount_due::float8, i.amount_paid::float8, i.penalty_amount::float8,
           i.status, i.created_at,
           c.type AS credit_type,
           cu.id AS customer_id, cu.full_name AS customer_name, cu.dni AS customer_dni,
           u.id  AS collector_id, u.full_name AS collector_name
    FROM installments i
    JOIN credits c    ON c.id  = i.credit_id
    JOIN customers cu ON cu.id = c.customer_id
    LEFT JOIN users u ON u.id  = cu.assigned_collector_id
    WHERE 1=1`;
  const params = [];
  if (credit_id)    { params.push(credit_id);    q += ` AND i.credit_id = $${params.length}`; }
  if (status)       { params.push(status);       q += ` AND i.status = $${params.length}`; }
  if (collector_id) { params.push(collector_id); q += ` AND cu.assigned_collector_id = $${params.length}`; }
  q += ` ORDER BY i.due_date ASC, i.installment_number ASC`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT i.id, i.credit_id, i.installment_number, i.due_date, i.original_due_date,
            i.amount_due::float8, i.amount_paid::float8, i.penalty_amount::float8,
            i.status, i.created_at, i.updated_at,
            c.type AS credit_type, c.total_amount::float8 AS credit_total,
            cu.full_name AS customer_name, cu.dni AS customer_dni
     FROM installments i
     JOIN credits c    ON c.id  = i.credit_id
     JOIN customers cu ON cu.id = c.customer_id
     WHERE i.id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

const applyPenalty = async (id, penaltyAmount) => {
  const r = await pool.query(
    `UPDATE installments
     SET penalty_amount = penalty_amount + $1,
         amount_due     = amount_due + $1,
         status         = 'OVERDUE',
         updated_at     = NOW()
     WHERE id = $2
     RETURNING id, amount_due::float8, penalty_amount::float8, status`,
    [penaltyAmount, id]
  );
  return r.rows[0] || null;
};

const waivePenalty = async (id) => {
  const r = await pool.query(
    `UPDATE installments
     SET amount_due     = amount_due - penalty_amount,
         penalty_amount = 0,
         updated_at     = NOW()
     WHERE id = $1
     RETURNING id, amount_due::float8, penalty_amount::float8, status`,
    [id]
  );
  return r.rows[0] || null;
};

// Pago anticipado directo de una cuota (sin flujo de pre-carga)
const earlyPay = async (client, id, adminId, paymentMethod, transferReference) => {
  // Marca la cuota como PAID con el saldo restante
  const instRes = await client.query(
    `UPDATE installments
     SET status      = 'PAID',
         amount_paid = amount_due,
         updated_at  = NOW()
     WHERE id = $1
     RETURNING id, credit_id, amount_due::float8, installment_number`,
    [id]
  );
  const inst = instRes.rows[0];

  // Registra el pago directamente aprobado
  await client.query(
    `INSERT INTO payments
       (installment_id, collector_id, amount_received, payment_method, transfer_reference,
        status, approved_by, approved_at, notes)
     VALUES ($1, $2, $3, $4, $5, 'APPROVED', $2, NOW(), 'Pago anticipado de cuota')`,
    [inst.id, adminId, inst.amount_due, paymentMethod, transferReference || null]
  );

  return inst;
};

/**
 * Devuelve el log cronológico de gestiones sobre una cuota:
 *  - Cobros (payments) con su estado y monto
 *  - Intentos de cobranza (collection_attempts) — NO_PAYMENT / NOT_FOUND
 *
 * Ordenado por created_at DESC (más reciente primero) para mostrar
 * la actividad reciente al admin/cobrador en la UI.
 *
 * @param {string} installmentId
 * @returns {Promise<Array>}
 */
const findManagementLog = async (installmentId) => {
  const r = await pool.query(
    `SELECT
        'PAYMENT'              AS event_type,
        p.id                   AS event_id,
        p.created_at,
        p.next_visit_date,
        NULL                   AS reason,
        p.notes,
        p.amount_received::float8 AS amount,
        p.status               AS payment_status,
        p.payment_method,
        p.is_reversal,
        p.admin_direct,
        p.rejection_reason,
        u.full_name            AS collector_name,
        NULL::timestamptz      AS voided_at,
        NULL::text             AS voided_by_name
     FROM payments p
     LEFT JOIN users u ON u.id = p.collector_id
     WHERE p.installment_id = $1
     UNION ALL
     SELECT
        ca.attempt_type        AS event_type,
        ca.id                  AS event_id,
        ca.created_at,
        ca.next_visit_date,
        ca.reason,
        ca.notes,
        NULL                   AS amount,
        NULL                   AS payment_status,
        NULL                   AS payment_method,
        FALSE                  AS is_reversal,
        FALSE                  AS admin_direct,
        NULL                   AS rejection_reason,
        u.full_name            AS collector_name,
        ca.voided_at,
        uv.full_name           AS voided_by_name
     FROM collection_attempts ca
     LEFT JOIN users u  ON u.id  = ca.collector_id
     LEFT JOIN users uv ON uv.id = ca.voided_by
     WHERE ca.installment_id = $1
     ORDER BY created_at DESC`,
    [installmentId]
  );
  return r.rows;
};

module.exports = { findAll, findById, applyPenalty, waivePenalty, earlyPay, findManagementLog };
