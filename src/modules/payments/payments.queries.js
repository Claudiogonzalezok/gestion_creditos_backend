const pool = require('../../config/db');

const findAll = async ({ status, collector_id, installment_id } = {}) => {
  let q = `
    SELECT p.id, p.installment_id, p.amount_received::float8, p.payment_method,
           p.transfer_reference, p.status, p.rejection_reason, p.notes, p.created_at,
           p.approved_at, p.approved_by,
           i.installment_number, i.amount_due::float8, i.due_date,
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
    `SELECT p.id, p.installment_id, p.collector_id, p.amount_received::float8, p.payment_method,
            p.transfer_reference, p.status, p.rejection_reason, p.notes,
            p.created_at, p.approved_at, p.approved_by,
            i.installment_number, i.amount_due::float8, i.amount_paid::float8,
            i.due_date, i.penalty_amount::float8,
            c.id AS credit_id, c.type AS credit_type, c.customer_id, c.payment_frequency,
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

// Suma de pre-cargas PENDING para una cuota (monto comprometido pendiente de aprobación)
const getPendingCommittedAmount = async (installmentId) => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount_received), 0)::float8 AS total
     FROM payments
     WHERE installment_id = $1 AND status = 'PENDING'`,
    [installmentId]
  );
  return r.rows[0].total;
};

const create = async ({ installment_id, collector_id, amount_received, payment_method, transfer_reference, notes }) => {
  const r = await pool.query(
    `INSERT INTO payments (installment_id, collector_id, amount_received, payment_method, transfer_reference, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, installment_id, amount_received::float8, payment_method, status, created_at`,
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

// Aplica el cobro sobre la cuota, sin exceder el saldo real pendiente
const updateInstallment = async (client, installmentId, amountReceived, amountDue, currentAmountPaid) => {
  const remaining   = amountDue - currentAmountPaid;
  const toApply     = Math.min(amountReceived, remaining);
  const newTotal    = currentAmountPaid + toApply;
  const newStatus   = newTotal >= amountDue ? 'PAID' : 'PARTIAL';
  await client.query(
    `UPDATE installments
     SET status      = $1,
         amount_paid = $2,
         updated_at  = NOW()
     WHERE id = $3`,
    [newStatus, newTotal, installmentId]
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

// Liquidación por cobro normal (última cuota pagada)
const settleCredit = async (client, creditId) => {
  await client.query(
    `UPDATE credits
     SET status = 'SETTLED', settled_at = NOW(), settlement_type = 'NORMAL', updated_at = NOW()
     WHERE id = $1`,
    [creditId]
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

// Saldo pendiente total de todas las cuotas no pagadas del crédito
const getTotalPendingBalance = async (creditId) => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount_due - amount_paid), 0)::float8 AS total
     FROM installments
     WHERE credit_id = $1 AND status NOT IN ('PAID')`,
    [creditId]
  );
  return r.rows[0].total;
};

// Cuotas pendientes/vencidas/parciales ordenadas desde un número de cuota dado
const getPendingInstallmentsFrom = async (client, creditId, fromInstallmentNumber) => {
  const r = await client.query(
    `SELECT id, installment_number, due_date,
            amount_due::float8, amount_paid::float8, penalty_amount::float8, status
     FROM installments
     WHERE credit_id = $1
       AND status NOT IN ('PAID')
       AND installment_number >= $2
     ORDER BY installment_number`,
    [creditId, fromInstallmentNumber]
  );
  return r.rows;
};

// Reasigna las fechas de vencimiento de las cuotas restantes (no PAID) empezando
// desde HOY + 1 período. Independientemente de cuántas cuotas se adelantaron,
// la siguiente cuota siempre vence el próximo período desde la fecha de aprobación.
// Guarda original_due_date antes de modificar (solo si aún no fue guardada).
const shiftInstallmentDates = async (client, creditId, paymentFrequency, baseDueDate) => {
  let interval;
  if (paymentFrequency === 'WEEKLY')        interval = '1 week';
  else if (paymentFrequency === 'BIWEEKLY') interval = '2 weeks';
  else                                       interval = '1 month';

  // Las cuotas restantes toman las fechas de las cuotas adelantadas:
  // rn=1 → baseDueDate + 0 (toma la fecha de la primera cuota adelantada)
  // rn=2 → baseDueDate + 1 intervalo, etc.
  await client.query(
    `WITH ordered AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY installment_number) AS rn
       FROM installments
       WHERE credit_id = $1 AND status NOT IN ('PAID')
     )
     UPDATE installments i
     SET original_due_date = COALESCE(i.original_due_date, i.due_date),
         due_date           = (GREATEST($3::date, CURRENT_DATE) + ((ordered.rn - 1) * $2::interval))::date,
         updated_at         = NOW()
     FROM ordered
     WHERE i.id = ordered.id`,
    [creditId, interval, baseDueDate]
  );
};

// Marca una cuota como pagada por adelanto con nota auditada
const markInstallmentAsPrepaid = async (client, installmentId, adminId, note, paymentMethod) => {
  await client.query(
    `INSERT INTO payments
       (installment_id, collector_id, amount_received, payment_method, status, approved_by, approved_at, notes)
     SELECT id, $1, amount_due - amount_paid, $2, 'APPROVED', $1, NOW(), $3
     FROM installments WHERE id = $4`,
    [adminId, paymentMethod, note, installmentId]
  );
  await client.query(
    `UPDATE installments
     SET status = 'PAID', amount_paid = amount_due, updated_at = NOW()
     WHERE id = $1`,
    [installmentId]
  );
};

module.exports = {
  findAll, findById, getPendingCommittedAmount, create,
  approve, updateInstallment, countPendingInstallments, settleCredit, reject,
  getTotalPendingBalance, getPendingInstallmentsFrom, shiftInstallmentDates, markInstallmentAsPrepaid,
};
