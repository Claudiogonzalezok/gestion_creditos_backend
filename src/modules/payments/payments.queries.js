const pool = require('../../config/db');

const findAll = async ({ status, collector_id, installment_id } = {}) => {
  let q = `
    SELECT p.id, p.installment_id, p.amount_received, p.payment_method,
           p.transfer_reference, p.status, p.rejection_reason, p.notes, p.created_at,
           p.approved_at, p.approved_by,
           i.installment_number, i.amount_due, i.due_date,
           c.id AS credit_id, c.type AS credit_type,
           cu.full_name AS customer_name, cu.dni AS customer_dni,
           u.full_name  AS collector_name
    FROM payments p
    JOIN installments i ON i.id  = p.installment_id
    JOIN credits c      ON c.id  = i.credit_id
    JOIN customers cu   ON cu.id = c.customer_id
    LEFT JOIN users u   ON u.id  = p.collector_id
    WHERE 1=1`;
  const params = [];
  if (status)         { params.push(status);         q += ` AND p.status = $${params.length}`; }
  if (collector_id)   { params.push(collector_id);   q += ` AND p.collector_id = $${params.length}`; }
  if (installment_id) { params.push(installment_id); q += ` AND p.installment_id = $${params.length}`; }
  q += ` ORDER BY p.created_at DESC`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT p.id, p.installment_id, p.collector_id, p.amount_received, p.payment_method,
            p.transfer_reference, p.status, p.rejection_reason, p.notes,
            p.created_at, p.approved_at, p.approved_by,
            i.installment_number, i.amount_due, i.amount_paid, i.due_date, i.penalty_amount,
            c.id AS credit_id, c.type AS credit_type, c.customer_id,
            cu.full_name AS customer_name, cu.dni AS customer_dni,
            u.full_name  AS collector_name
     FROM payments p
     JOIN installments i ON i.id  = p.installment_id
     JOIN credits c      ON c.id  = i.credit_id
     JOIN customers cu   ON cu.id = c.customer_id
     LEFT JOIN users u   ON u.id  = p.collector_id
     WHERE p.id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

const hasPendingPayment = async (installmentId) => {
  const r = await pool.query(
    `SELECT id FROM payments WHERE installment_id = $1 AND status = 'PENDING' LIMIT 1`,
    [installmentId]
  );
  return r.rows.length > 0;
};

const create = async ({ installment_id, collector_id, amount_received, payment_method, transfer_reference, notes }) => {
  const r = await pool.query(
    `INSERT INTO payments (installment_id, collector_id, amount_received, payment_method, transfer_reference, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, installment_id, amount_received, payment_method, status, created_at`,
    [installment_id, collector_id, amount_received, payment_method, transfer_reference || null, notes || null]
  );
  return r.rows[0];
};

const approve = async (client, id, adminId) => {
  await client.query(
    `UPDATE payments SET status = 'APPROVED', approved_by = $1, approved_at = NOW()
     WHERE id = $2`,
    [adminId, id]
  );
};

const updateInstallment = async (client, installmentId, amountReceived, amountDue) => {
  const newStatus = amountReceived >= amountDue ? 'PAID' : 'PARTIAL';
  await client.query(
    `UPDATE installments
     SET status      = $1,
         amount_paid = amount_paid + $2,
         updated_at  = NOW()
     WHERE id = $3`,
    [newStatus, amountReceived, installmentId]
  );
  return newStatus;
};

const countPendingInstallments = async (client, creditId) => {
  const r = await client.query(
    `SELECT COUNT(*) FROM installments
     WHERE credit_id = $1 AND status NOT IN ('PAID')`,
    [creditId]
  );
  return parseInt(r.rows[0].count);
};

const settleCredit = async (client, creditId) => {
  await client.query(
    `UPDATE credits SET status = 'SETTLED', updated_at = NOW() WHERE id = $1`, [creditId]
  );
};

const reject = async (id, rejectionReason, adminId) => {
  await pool.query(
    `UPDATE payments
     SET status = 'REJECTED', rejection_reason = $1, approved_by = $2, approved_at = NOW()
     WHERE id = $3`,
    [rejectionReason, adminId, id]
  );
};

module.exports = {
  findAll, findById, hasPendingPayment, create,
  approve, updateInstallment, countPendingInstallments, settleCredit, reject,
};
