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

// Proceso automático — ejecutado desde el cron job de mora
const markOverdue = async (graceDays) => {
  const r = await pool.query(
    `UPDATE installments SET status = 'OVERDUE', updated_at = NOW()
     WHERE status IN ('PENDING', 'PARTIAL')
       AND due_date < CURRENT_DATE - ($1::integer - 1)
     RETURNING id`,
    [graceDays]
  );
  return r.rowCount;
};

module.exports = { findAll, findById, applyPenalty, waivePenalty, earlyPay, markOverdue };
