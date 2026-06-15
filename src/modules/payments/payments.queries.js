const pool = require("../../config/db");

const findAll = async ({ status, collector_id, installment_id } = {}) => {
  let q = `
    SELECT p.id, p.installment_id, p.amount_received::float8,
           p.amount_cash::float8, p.amount_transfer::float8, p.payment_method,
           p.transfer_reference, p.status, p.rejection_reason, p.notes, p.next_visit_date, p.created_at,
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
  if (status) {
    params.push(status);
    q += ` AND p.status = $${params.length}`;
  }
  if (collector_id) {
    params.push(collector_id);
    q += ` AND p.collector_id = $${params.length}`;
  }
  if (installment_id) {
    params.push(installment_id);
    q += ` AND p.installment_id = $${params.length}`;
  }
  q += ` ORDER BY p.created_at DESC`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT p.id, p.installment_id, p.collector_id, p.amount_received::float8,
            p.amount_cash::float8, p.amount_transfer::float8, p.payment_method,
            p.transfer_reference, p.status, p.rejection_reason, p.notes, p.next_visit_date,
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
    [id],
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
    [installmentId],
  );
  return r.rows[0].total;
};

const create = async (
  {
    installment_id,
    collector_id,
    amount_received,
    amount_cash,
    amount_transfer,
    payment_method,
    transfer_reference,
    notes,
    next_visit_date,
    cash_session_id,
  },
  db = pool,
) => {
  const r = await db.query(
    `INSERT INTO payments (installment_id, collector_id, amount_received, amount_cash, amount_transfer, payment_method, transfer_reference, notes, next_visit_date, cash_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, installment_id, amount_received::float8, amount_cash::float8, amount_transfer::float8, payment_method, status, next_visit_date, cash_session_id, created_at`,
    [
      installment_id,
      collector_id,
      amount_received,
      amount_cash || 0,
      amount_transfer || 0,
      payment_method,
      transfer_reference || null,
      notes || null,
      next_visit_date || null,
      cash_session_id || null,
    ],
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
            p.amount_cash::float8, p.amount_transfer::float8,
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
    [id],
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
    [installmentId],
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
    [creditId],
  );
  return r.rows[0] || null;
};

const approve = async (client, id, adminId, cashSessionId = null) => {
  // V4.2: cash_session_id se setea al aprobar (no al crear). En V4.3 el caller
  // pasará la caja activa de la jornada; por ahora puede pasar la caja del
  // admin que aprueba (comportamiento equivalente al Fase 2 pre-V4 en la
  // práctica, ya que ambos son la misma caja cuando el admin opera la jornada).
  await client.query(
    `UPDATE payments
     SET status = 'APPROVED',
         approved_by = $1,
         approved_at = NOW(),
         cash_session_id = COALESCE($3, cash_session_id)
     WHERE id = $2`,
    [adminId, id, cashSessionId],
  );
};

/**
 * Aplica un cobro sobre la cuota sin exceder el saldo real pendiente.
 * El nuevo status se deriva de tres ejes: saldo restante, due_date y grace_days,
 * en lugar de colapsar todo a PARTIAL — así una cuota vencida con pago parcial
 * mantiene su estado OVERDUE y no oscila a PARTIAL.
 *
 * Reglas de transición de status (en SQL, para evaluarse con el due_date real):
 *   1. amount_paid_nuevo ≥ amount_due                       → PAID
 *   2. due_date + grace_days < CURRENT_DATE                  → OVERDUE
 *   3. amount_paid_nuevo > 0                                 → PARTIAL
 *   4. caso restante                                         → PENDING
 *
 * @param {object} client      - Cliente de transacción pg.
 * @param {string} installmentId
 * @param {number} amountReceived - Monto recibido a aplicar.
 * @param {number} amountDue      - amount_due actual de la cuota.
 * @param {number} currentAmountPaid - amount_paid antes del cobro.
 * @param {number} graceDays      - Días de gracia del system_config.
 * @returns {Promise<string>} Status final de la cuota tras aplicar el pago.
 */
const updateInstallment = async (
  client,
  installmentId,
  amountReceived,
  amountDue,
  currentAmountPaid,
  graceDays,
) => {
  const remaining = amountDue - currentAmountPaid;
  const toApply = Math.min(amountReceived, remaining);
  const newTotal = currentAmountPaid + toApply;
  const r = await client.query(
    `UPDATE installments
     SET amount_paid = $1,
         status      = CASE
                         WHEN $1 >= amount_due                                          THEN 'PAID'
                         WHEN due_date < (CURRENT_DATE - ($2)::int * INTERVAL '1 day') THEN 'OVERDUE'
                         WHEN $1 > 0                                                    THEN 'PARTIAL'
                         ELSE 'PENDING'
                       END,
         updated_at  = NOW()
     WHERE id = $3
     RETURNING status`,
    [newTotal, graceDays, installmentId],
  );
  return r.rows[0].status;
};

const countPendingInstallments = async (client, creditId) => {
  const r = await client.query(
    `SELECT COUNT(*) FROM installments
     WHERE credit_id = $1 AND status NOT IN ('PAID','REFINANCED','PLAN_CHANGE_CANCELLED')`,
    [creditId],
  );
  return parseInt(r.rows[0].count);
};

// Liquidación por cobro normal (última cuota pagada)
const settleCredit = async (client, creditId) => {
  await client.query(
    `UPDATE credits
     SET status = 'SETTLED', settled_at = NOW(), settlement_type = 'NORMAL', updated_at = NOW()
     WHERE id = $1`,
    [creditId],
  );
};

/**
 * Marca una pre-carga como RECHAZADA. Debe ejecutarse DENTRO de una transacción
 * con el payment ya lockeado vía lockAndGetPayment, y con guard SQL adicional
 * sobre status='PENDING' para defensa contra races entre approve y reject
 * concurrentes.
 *
 * @param {object} client - Cliente de transacción pg con el payment ya lockeado.
 * @param {string} id
 * @param {string} rejectionReason
 * @param {string} adminId
 * @returns {Promise<boolean>} true si se rechazó (status era PENDING), false si no.
 */
const reject = async (client, id, rejectionReason, adminId) => {
  const r = await client.query(
    `UPDATE payments
     SET status = 'REJECTED', rejection_reason = $1, approved_by = $2, approved_at = NOW()
     WHERE id = $3 AND status = 'PENDING'
     RETURNING id`,
    [rejectionReason, adminId, id],
  );
  return r.rowCount > 0;
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
     WHERE i.credit_id = $1 AND i.status NOT IN ('PAID','REFINANCED','PLAN_CHANGE_CANCELLED')`,
    [creditId],
  );
  return Math.max(r.rows[0].total, 0);
};

// Cuotas pendientes/vencidas/parciales ordenadas desde un número de cuota dado
const getPendingInstallmentsFrom = async (
  client,
  creditId,
  fromInstallmentNumber,
) => {
  const r = await client.query(
    `SELECT id, installment_number, due_date,
            amount_due::float8, amount_paid::float8, penalty_amount::float8, status
     FROM installments
     WHERE credit_id = $1
       AND status NOT IN ('PAID','REFINANCED','PLAN_CHANGE_CANCELLED')
       AND installment_number >= $2
     ORDER BY installment_number`,
    [creditId, fromInstallmentNumber],
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
const shiftInstallmentDates = async (
  client,
  creditId,
  paymentFrequency,
  baseDueDate,
) => {
  let interval;
  if (paymentFrequency === "WEEKLY") interval = "1 week";
  else if (paymentFrequency === "BIWEEKLY") interval = "2 weeks";
  else interval = "30 days";

  // Las cuotas restantes toman las fechas de las cuotas adelantadas:
  // rn=1 → baseDueDate + 0 (toma la fecha de la primera cuota adelantada)
  // rn=2 → baseDueDate + 1 intervalo, etc.
  await client.query(
    `WITH ordered AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY installment_number) AS rn
       FROM installments
       WHERE credit_id = $1 AND status NOT IN ('PAID','REFINANCED','PLAN_CHANGE_CANCELLED')
     )
     UPDATE installments i
     SET original_due_date = COALESCE(i.original_due_date, i.due_date),
         due_date           = (GREATEST($3::date, CURRENT_DATE) + ((ordered.rn - 1) * $2::interval))::date,
         updated_at         = NOW()
     FROM ordered
     WHERE i.id = ordered.id`,
    [creditId, interval, baseDueDate],
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
 * @param {number} cashRatio - Proporción del saldo a imputar a efectivo (0..1).
 *   Hereda la mezcla del cobro cabecera: 1 si fue todo efectivo, 0 si fue todo
 *   transferencia, o el ratio cash/total si fue mixto. El desglose se calcula en
 *   SQL sobre el saldo real de la cuota para que amount_cash + amount_transfer
 *   = amount_received exactamente (sin drift de redondeo JS/SQL).
 */
const markInstallmentAsPrepaid = async (
  client,
  installmentId,
  adminId,
  note,
  paymentMethod,
  transferReference = null,
  parentPaymentId = null,
  cashRatio = null,
) => {
  await client.query(
    `INSERT INTO payments
       (installment_id, collector_id, amount_received, amount_cash, amount_transfer,
        payment_method, transfer_reference,
        status, approved_by, approved_at, notes, parent_payment_id)
     SELECT id, $1,
            (amount_due - amount_paid),
            ROUND((amount_due - amount_paid) * $7, 2),
            (amount_due - amount_paid) - ROUND((amount_due - amount_paid) * $7, 2),
            $2, $3, 'APPROVED', $1, NOW(), $4, $6
      FROM installments WHERE id = $5`,
    [
      adminId,
      paymentMethod,
      transferReference || null,
      note,
      installmentId,
      parentPaymentId || null,
      // Fallback por método si no se pasó ratio (llamadas legacy de un solo medio).
      cashRatio != null ? cashRatio : paymentMethod === "CASH" ? 1 : 0,
    ],
  );
  await client.query(
    `UPDATE installments
      SET status = 'PAID', amount_paid = amount_due, updated_at = NOW()
     WHERE id = $1`,
    [installmentId],
  );
};

/**
 * Inserta un pago ya aprobado (flujo admin-direct o bulk).
 * @returns {Promise<object>} Pago creado con su id.
 */
const createApproved = async (
  client,
  {
    installmentId,
    adminId,
    amountReceived,
    amountCash,
    amountTransfer,
    paymentMethod,
    transferReference,
    notes,
    cashSessionId,
  },
) => {
  const r = await client.query(
    `INSERT INTO payments
       (installment_id, collector_id, amount_received, amount_cash, amount_transfer, payment_method, transfer_reference,
        status, approved_by, approved_at, notes, admin_direct, cash_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'APPROVED', $2, NOW(), $8, TRUE, $9)
     RETURNING id, installment_id, amount_received::float8, amount_cash::float8, amount_transfer::float8, payment_method, status, cash_session_id, created_at`,
    [
      installmentId,
      adminId,
      amountReceived,
      amountCash || 0,
      amountTransfer || 0,
      paymentMethod,
      transferReference || null,
      notes || null,
      cashSessionId || null,
    ],
  );
  return r.rows[0];
};

/**
 * Inserta un pago de reversión compensatoria (is_reversal=TRUE).
 * El monto es el mismo que el original (se registra como salida de caja).
 * @returns {Promise<object>} Pago de reversión con su id.
 */
const createReversal = async (
  client,
  {
    installmentId,
    adminId,
    amountReceived,
    amountCash,
    amountTransfer,
    paymentMethod,
    transferReference,
    reason,
    originalPaymentId,
    cashSessionId,
  },
) => {
  const r = await client.query(
    `INSERT INTO payments
       (installment_id, collector_id, amount_received, amount_cash, amount_transfer, payment_method, transfer_reference,
        status, approved_by, approved_at, notes, is_reversal, reversal_reason, reversed_by_payment_id, cash_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'APPROVED', $2, NOW(), NULL, TRUE, $8, $9, $10)
     RETURNING id, installment_id, amount_received::float8, amount_cash::float8, amount_transfer::float8, payment_method, status, cash_session_id`,
    [
      installmentId,
      adminId,
      amountReceived,
      amountCash || 0,
      amountTransfer || 0,
      paymentMethod,
      transferReference || null,
      reason,
      originalPaymentId,
      cashSessionId || null,
    ],
  );
  return r.rows[0];
};

/**
 * Devuelve los sub-pagos generados por distribución de un cobro principal.
 */
const findChildPayments = async (client, parentPaymentId) => {
  const r = await client.query(
    `SELECT p.id, p.installment_id, p.amount_received::float8,
            p.amount_cash::float8, p.amount_transfer::float8,
            p.payment_method, p.transfer_reference, p.status,
            i.installment_number, i.amount_due::float8, i.amount_paid::float8, i.due_date
     FROM payments p
     JOIN installments i ON i.id = p.installment_id
     WHERE p.parent_payment_id = $1
     ORDER BY i.installment_number`,
    [parentPaymentId],
  );
  return r.rows;
};

/**
 * Devuelve todos los pagos aprobados de un crédito (para vista de historial).
 */
const findPaymentsByCredit = async (creditId) => {
  const r = await pool.query(
    `SELECT p.id, p.installment_id, p.collector_id, p.amount_received::float8,
            p.amount_cash::float8, p.amount_transfer::float8,
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
    [creditId],
  );
  return r.rows;
};

/**
 * Revierte una cuota a su estado anterior al cobro que se está reversando.
 * Resta el monto recibido de amount_paid y recalcula el status considerando
 * due_date + grace_days. Si tras la reversión la cuota sigue vencida, vuelve
 * a OVERDUE (antes quedaba en PENDING o PARTIAL incorrectamente).
 *
 * @param {object} client - Cliente de transacción.
 * @param {string} installmentId
 * @param {number} amountToRestore - Monto del cobro original a deshacer.
 * @param {number} graceDays - Días de gracia del system_config.
 */
const restoreInstallmentFromReversal = async (
  client,
  installmentId,
  amountToRestore,
  graceDays,
) => {
  await client.query(
    `UPDATE installments
     SET amount_paid = GREATEST(amount_paid - $1, 0),
         status      = CASE
                         WHEN GREATEST(amount_paid - $1, 0) >= amount_due               THEN 'PAID'
                         WHEN due_date < (CURRENT_DATE - ($3)::int * INTERVAL '1 day') THEN 'OVERDUE'
                         WHEN GREATEST(amount_paid - $1, 0) > 0                         THEN 'PARTIAL'
                         ELSE 'PENDING'
                       END,
         updated_at  = NOW()
     WHERE id = $2`,
    [amountToRestore, installmentId, graceDays],
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
    [installmentId],
  );
  return r.rows[0] || null;
};

module.exports = {
  findAll,
  findById,
  getPendingCommittedAmount,
  create,
  lockAndGetPayment,
  lockAndGetInstallment,
  lockAndGetCredit,
  approve,
  updateInstallment,
  countPendingInstallments,
  settleCredit,
  reject,
  getTotalPendingBalance,
  getPendingInstallmentsFrom,
  shiftInstallmentDates,
  markInstallmentAsPrepaid,
  createApproved,
  createReversal,
  findChildPayments,
  findPaymentsByCredit,
  restoreInstallmentFromReversal,
  getCreditStatusByInstallment,
};
