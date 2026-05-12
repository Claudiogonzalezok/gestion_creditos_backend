const pool = require('../../config/db');

const findAll = async ({ status, collector_id, installment_id } = {}) => {
  let q = `
    SELECT p.id, p.installment_id, p.amount_received::float8, p.payment_method,
           p.transfer_reference, p.status, p.rejection_reason, p.notes, p.created_at,
           p.approved_at, p.approved_by,
           p.is_reversal, p.admin_direct, p.parent_payment_id,
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
            p.is_reversal, p.admin_direct, p.reversal_reason,
            p.created_at, p.approved_at, p.approved_by,
            i.installment_number, i.amount_due::float8, i.amount_paid::float8,
            i.due_date, i.penalty_amount::float8,
            c.id AS credit_id, c.type AS credit_type, c.customer_id, c.payment_frequency,
            cu.full_name AS customer_name, cu.dni AS customer_dni,
            u.full_name  AS collector_name,
            (SELECT id FROM payments WHERE reversed_by_payment_id = p.id LIMIT 1) AS reversal_payment_id
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
/**
 * Suma el monto comprometido en pre-cargas pendientes de una cuota.
 * @param {string} installmentId - ID de la cuota.
 * @returns {Promise<number>} Total pendiente de aprobación ya comprometido.
 */
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

// ── Locks transaccionales (SELECT FOR UPDATE) ─────────────────────────────────
// Deben usarse dentro de una transacción activa para serializar operaciones concurrentes.

/**
 * Obtiene un payment con lock exclusivo (FOR UPDATE) dentro de una transacción.
 * Previene aprobaciones o reversiones simultáneas sobre el mismo cobro.
 * @param {object} client - Cliente de transacción pg.
 * @param {string} id - ID del payment.
 * @returns {Promise<object|null>}
 */
const lockAndGetPayment = async (client, id) => {
  const r = await client.query(
    `SELECT p.id, p.installment_id, p.collector_id, p.amount_received::float8,
            p.payment_method, p.transfer_reference, p.status, p.notes,
            p.is_reversal, p.admin_direct, p.reversed_by_payment_id,
            i.installment_number, i.amount_due::float8, i.amount_paid::float8,
            i.due_date, i.penalty_amount::float8,
            c.id AS credit_id, c.type AS credit_type, c.customer_id, c.payment_frequency,
            cu.full_name AS customer_name, cu.dni AS customer_dni,
            u.full_name  AS collector_name,
            (SELECT id FROM payments rev WHERE rev.reversed_by_payment_id = p.id LIMIT 1) AS reversal_payment_id
     FROM payments p
     JOIN installments i ON i.id  = p.installment_id
     JOIN credits c      ON c.id  = i.credit_id
     JOIN customers cu   ON cu.id = c.customer_id
     LEFT JOIN users u   ON u.id  = p.collector_id
     WHERE p.id = $1
     FOR UPDATE OF p`,
    [id]
  );
  return r.rows[0] || null;
};

/**
 * Obtiene una cuota con lock exclusivo (FOR UPDATE) dentro de una transacción.
 * Previene actualizaciones concurrentes de amount_paid y status.
 * @param {object} client - Cliente de transacción pg.
 * @param {string} installmentId - ID de la cuota.
 * @returns {Promise<object|null>}
 */
const lockAndGetInstallment = async (client, installmentId) => {
  const r = await client.query(
    `SELECT i.id, i.credit_id, i.installment_number, i.due_date,
            i.amount_due::float8, i.amount_paid::float8, i.penalty_amount::float8, i.status,
            c.payment_frequency
     FROM installments i
     JOIN credits c ON c.id = i.credit_id
     WHERE i.id = $1
     FOR UPDATE OF i`,
    [installmentId]
  );
  return r.rows[0] || null;
};

/**
 * Obtiene un crédito con lock exclusivo (FOR UPDATE) dentro de una transacción.
 * Previene race conditions en la transición ACTIVE → SETTLED cuando dos cuotas
 * se pagan de forma simultánea y ambas verifican el cierre del crédito.
 * @param {object} client - Cliente de transacción pg.
 * @param {string} creditId - ID del crédito.
 * @returns {Promise<object|null>}
 */
const lockAndGetCredit = async (client, creditId) => {
  const r = await client.query(
    `SELECT id, status FROM credits WHERE id = $1 FOR UPDATE`,
    [creditId]
  );
  return r.rows[0] || null;
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
    `SELECT (
       COALESCE(SUM(i.amount_due - i.amount_paid), 0)
       - COALESCE((
           SELECT SUM(p.amount_received)
           FROM payments p
           JOIN installments i2 ON i2.id = p.installment_id
           WHERE i2.credit_id = $1 AND p.status = 'PENDING'
         ), 0)
     )::float8 AS total
     FROM installments i
     WHERE i.credit_id = $1 AND i.status NOT IN ('PAID')`,
    [creditId]
  );
  return Math.max(r.rows[0].total, 0);
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
/**
 * Recorre las fechas de las cuotas aún impagas hacia adelante conservando auditoría.
 * Guarda la fecha original solo la primera vez que una cuota es reprogramada.
 * @param {object} client - Cliente de transacción.
 * @param {string} creditId - ID del crédito afectado.
 * @param {string} paymentFrequency - Frecuencia del crédito.
 * @param {string|Date} baseDueDate - Fecha base desde la que se recalcula el plan.
 */
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
/**
 * Marca una cuota futura como pagada por adelanto y registra el movimiento aprobado.
 * Propaga método y referencia para mantener trazabilidad cuando el cobro fue transferencia.
 * @param {object} client - Cliente de transacción.
 * @param {string} installmentId - ID de la cuota adelantada.
 * @param {string} adminId - Admin que aprueba el adelanto.
 * @param {string} note - Nota auditada del movimiento.
 * @param {string} paymentMethod - Método usado en el cobro original.
 * @param {string|null} transferReference - Referencia bancaria si aplica.
 */
/**
 * @param {string|null} parentPaymentId - ID del cobro principal que generó este sub-pago por distribución.
 */
const markInstallmentAsPrepaid = async (client, installmentId, adminId, note, paymentMethod, transferReference = null, parentPaymentId = null) => {
  await client.query(
    `INSERT INTO payments
       (installment_id, collector_id, amount_received, payment_method, transfer_reference,
        status, approved_by, approved_at, notes, parent_payment_id)
     SELECT id, $1, amount_due - amount_paid, $2, $3, 'APPROVED', $1, NOW(), $4, $6
      FROM installments WHERE id = $5`,
    [adminId, paymentMethod, transferReference || null, note, installmentId, parentPaymentId || null]
  );
  await client.query(
    `UPDATE installments
      SET status = 'PAID', amount_paid = amount_due, updated_at = NOW()
     WHERE id = $1`,
    [installmentId]
  );
};

/**
 * Inserta un pago ya aprobado (flujo admin-direct o bulk).
 * @returns {Promise<object>} Pago creado con su id.
 */
const createApproved = async (client, { installmentId, adminId, amountReceived, paymentMethod, transferReference, notes }) => {
  const r = await client.query(
    `INSERT INTO payments
       (installment_id, collector_id, amount_received, payment_method, transfer_reference,
        status, approved_by, approved_at, notes, admin_direct)
     VALUES ($1, $2, $3, $4, $5, 'APPROVED', $2, NOW(), $6, TRUE)
     RETURNING id, installment_id, amount_received::float8, payment_method, status, created_at`,
    [installmentId, adminId, amountReceived, paymentMethod, transferReference || null, notes || null]
  );
  return r.rows[0];
};

/**
 * Inserta un pago de reversión compensatoria (is_reversal=TRUE).
 * El monto es el mismo que el original (se registra como salida de caja).
 * @returns {Promise<object>} Pago de reversión con su id.
 */
const createReversal = async (client, { installmentId, adminId, amountReceived, paymentMethod, transferReference, reason, originalPaymentId }) => {
  const r = await client.query(
    `INSERT INTO payments
       (installment_id, collector_id, amount_received, payment_method, transfer_reference,
        status, approved_by, approved_at, notes, is_reversal, reversal_reason, reversed_by_payment_id)
     VALUES ($1, $2, $3, $4, $5, 'APPROVED', $2, NOW(), NULL, TRUE, $6, $7)
     RETURNING id, installment_id, amount_received::float8, payment_method, status`,
    [installmentId, adminId, amountReceived, paymentMethod, transferReference || null, reason, originalPaymentId]
  );
  return r.rows[0];
};

/**
 * Devuelve los sub-pagos generados por distribución de un cobro principal.
 */
const findChildPayments = async (client, parentPaymentId) => {
  const r = await client.query(
    `SELECT p.id, p.installment_id, p.amount_received::float8, p.payment_method,
            p.transfer_reference, p.status,
            i.installment_number, i.amount_due::float8, i.amount_paid::float8, i.due_date
     FROM payments p
     JOIN installments i ON i.id = p.installment_id
     WHERE p.parent_payment_id = $1
     ORDER BY i.installment_number`,
    [parentPaymentId]
  );
  return r.rows;
};

/**
 * Devuelve todos los pagos aprobados de un crédito (para vista de historial).
 */
const findPaymentsByCredit = async (creditId) => {
  const r = await pool.query(
    `SELECT p.id, p.installment_id, p.collector_id, p.amount_received::float8,
            p.payment_method, p.transfer_reference, p.status, p.is_reversal,
            p.reversal_reason, p.admin_direct, p.notes,
            p.created_at, p.approved_at, p.approved_by,
            p.parent_payment_id, p.reversed_by_payment_id,
            i.installment_number, i.amount_due::float8, i.due_date,
            u.full_name AS collector_name,
            adm.full_name AS approver_name
     FROM payments p
     JOIN installments i ON i.id  = p.installment_id
     JOIN credits c      ON c.id  = i.credit_id
     LEFT JOIN users u   ON u.id  = p.collector_id
     LEFT JOIN users adm ON adm.id = p.approved_by
     WHERE c.id = $1 AND p.status = 'APPROVED'
     ORDER BY p.approved_at DESC NULLS LAST`,
    [creditId]
  );
  return r.rows;
};

/**
 * Revierte una cuota a su estado anterior al cobro que se está reversando.
 * Resta el monto recibido de amount_paid y recalcula el status.
 */
const restoreInstallmentFromReversal = async (client, installmentId, amountToRestore) => {
  await client.query(
    `UPDATE installments
     SET amount_paid = GREATEST(amount_paid - $1, 0),
         status      = CASE
                         WHEN GREATEST(amount_paid - $1, 0) <= 0         THEN 'PENDING'
                         WHEN GREATEST(amount_paid - $1, 0) < amount_due THEN 'PARTIAL'
                         ELSE 'PAID'
                       END,
         updated_at  = NOW()
     WHERE id = $2`,
    [amountToRestore, installmentId]
  );
};

/**
 * Obtiene el estado del crédito al que pertenece una cuota (sin lock, para validaciones rápidas).
 * @param {string} installmentId
 * @returns {Promise<{credit_id: string, status: string}|null>}
 */
const getCreditStatusByInstallment = async (installmentId) => {
  const r = await pool.query(
    `SELECT c.id AS credit_id, c.status
     FROM installments i
     JOIN credits c ON c.id = i.credit_id
     WHERE i.id = $1`,
    [installmentId]
  );
  return r.rows[0] || null;
};

module.exports = {
  findAll, findById, getPendingCommittedAmount, create,
  lockAndGetPayment, lockAndGetInstallment, lockAndGetCredit,
  approve, updateInstallment, countPendingInstallments, settleCredit, reject,
  getTotalPendingBalance, getPendingInstallmentsFrom, shiftInstallmentDates,
  markInstallmentAsPrepaid, createApproved, createReversal,
  findChildPayments, findPaymentsByCredit, restoreInstallmentFromReversal,
  getCreditStatusByInstallment,
};
