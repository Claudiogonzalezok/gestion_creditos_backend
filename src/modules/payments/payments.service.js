const pool                  = require('../../config/db');
const queries               = require('./payments.queries');
const cashMovementsQueries  = require('./cash_movements.queries');
const cashRegisterQueries   = require('../cashRegister/cashRegister.queries');
const { withTransaction }   = require('../../utils/transaction');
const { localDate }         = require('../../utils/date');

// ══════════════════════════════════════════════════════════════════════════════
// NÚCLEO FINANCIERO REUTILIZABLE
// Funciones privadas compartidas por todos los flujos de cobranza.
// NO llamar directamente desde controllers — solo desde funciones de este módulo.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Valida que la caja del día no esté cerrada.
 * La existencia de un registro en cash_registers para la fecha = caja cerrada.
 * Debe llamarse ANTES de iniciar la transacción de pago.
 * @param {string} date - Fecha contable 'YYYY-MM-DD'.
 * @throws {{ status: 409, message }} si la caja del día está cerrada.
 */
const _validateCajaOpen = async (date) => {
  const closed = await cashRegisterQueries.findByDate(date);
  if (closed)
    throw {
      status: 409,
      message: `La caja del ${date} ya fue cerrada. No es posible registrar cobros para ese día.`,
    };
};

/**
 * Distribuye el monto recibido sobre la cuota principal y cuotas siguientes si sobra saldo.
 * Toda la lógica financiera de distribución está centralizada aquí para reutilización.
 * Requiere un client con transacción activa.
 *
 * @param {object} client          - Cliente de transacción pg.
 * @param {object} payment         - Registro del payment con datos de la cuota y crédito.
 * @param {number} amountToApply   - Monto total a distribuir.
 * @param {string} adminId         - ID del usuario que aprueba (para cuotas adelantadas).
 * @returns {Promise<void>}
 */
const _applyPaymentToInstallments = async (client, payment, amountToApply, adminId) => {
  const amountDue   = parseFloat(payment.amount_due);
  const amountPaid  = parseFloat(payment.amount_paid);

  // Lock exclusivo sobre la cuota principal antes de modificarla
  await queries.lockAndGetInstallment(client, payment.installment_id);

  const newInstStatus = await queries.updateInstallment(
    client,
    payment.installment_id,
    amountToApply,
    amountDue,
    amountPaid
  );

  const round = (n) => Math.round(n * 100) / 100;
  let remaining = round(amountToApply - (amountDue - amountPaid));
  let paidCount = 0;

  // Si sobra saldo y la cuota principal quedó PAID, distribuir a cuotas siguientes
  if (remaining > 0 && newInstStatus === 'PAID') {
    const nextInstallments = await queries.getPendingInstallmentsFrom(
      client,
      payment.credit_id,
      payment.installment_number + 1
    );

    for (const inst of nextInstallments) {
      if (remaining <= 0) break;

      const instBalance = round(parseFloat(inst.amount_due) - parseFloat(inst.amount_paid));
      if (remaining >= instBalance) {
        await queries.markInstallmentAsPrepaid(
          client,
          inst.id,
          adminId,
          'Pago adelantado',
          payment.payment_method,
          payment.transfer_reference
        );
        remaining = round(remaining - instBalance);
        paidCount++;
      } else {
        await queries.updateInstallment(
          client,
          inst.id,
          remaining,
          parseFloat(inst.amount_due),
          parseFloat(inst.amount_paid)
        );
        remaining = 0;
      }
    }
  }

  // Si se adelantaron cuotas completas, recorrer vencimientos de las restantes
  if (paidCount > 0) {
    await queries.shiftInstallmentDates(
      client,
      payment.credit_id,
      payment.payment_frequency,
      payment.due_date
    );
  }
};

/**
 * Verifica si el crédito quedó totalmente liquidado y lo marca como SETTLED.
 * Aplica SELECT FOR UPDATE sobre credits para evitar cierre doble en pagos concurrentes.
 * Respeta la lógica de mora del cron — no recalcula ni modifica penalty_amount.
 *
 * @param {object} client    - Cliente de transacción pg.
 * @param {string} creditId  - ID del crédito a verificar.
 */
const _checkAndSettleCredit = async (client, creditId) => {
  // Lock sobre el crédito antes de evaluar cierre para evitar race conditions
  const credit = await queries.lockAndGetCredit(client, creditId);
  if (!credit || credit.status === 'SETTLED') return;

  const pendingCount = await queries.countPendingInstallments(client, creditId);
  if (pendingCount === 0) await queries.settleCredit(client, creditId);
};

/**
 * Registra el movimiento contable en cash_movements dentro de la transacción activa.
 * Debe ser la última operación antes del COMMIT para garantizar consistencia.
 *
 * @param {object} client
 * @param {object} params
 * @param {string} params.paymentId      - ID del payment que origina el movimiento.
 * @param {number} params.amount         - Monto positivo del movimiento.
 * @param {string} params.paymentMethod  - 'CASH' | 'TRANSFER'.
 * @param {string} params.movementType   - 'PAYMENT' | 'REVERSAL'.
 * @param {string} params.registerDate   - Fecha contable 'YYYY-MM-DD'.
 * @param {string} params.userId         - Usuario que ejecuta la operación.
 */
const _registerCashMovement = async (client, { paymentId, amount, paymentMethod, movementType, registerDate, userId }) => {
  await cashMovementsQueries.create(client, {
    paymentId,
    amount,
    movementType,
    paymentMethod,
    registerDate,
    createdBy: userId,
  });
};

// ══════════════════════════════════════════════════════════════════════════════
// API PÚBLICA DEL SERVICIO
// ══════════════════════════════════════════════════════════════════════════════

const getAll = async (filters, requestingUser) => {
  if (['COLLECTOR', 'SELLER_COLLECTOR'].includes(requestingUser.role))
    filters = { ...filters, collector_id: requestingUser.id };
  return queries.findAll(filters);
};

const getById = async (id) => {
  const payment = await queries.findById(id);
  if (!payment) throw { status: 404, message: 'Cobro no encontrado.' };
  return payment;
};

/**
 * Registra una pre-carga de cobro validando el saldo disponible del crédito.
 * Permite montos que cubran varias cuotas siempre que no superen el saldo pendiente total.
 * @param {object} data - Datos validados del cobro.
 * @param {object} requestingUser - Cobrador autenticado que registra la pre-carga.
 * @returns {Promise<object>} Pre-carga creada en estado pendiente.
 */
const create = async (data, requestingUser) => {
  const instCheck = await pool.query(
    `SELECT id, status, amount_due::float8, amount_paid::float8, credit_id FROM installments WHERE id = $1`,
    [data.installment_id]
  );
  if (!instCheck.rows.length) throw { status: 404, message: 'Cuota no encontrada.' };
  const inst = instCheck.rows[0];
  if (inst.status === 'PAID') throw { status: 409, message: 'Esta cuota ya fue pagada.' };

  const amountDue     = inst.amount_due;
  const amountPaid    = inst.amount_paid;
  const pendingAmount = await queries.getPendingCommittedAmount(data.installment_id);
  const available     = amountDue - amountPaid - pendingAmount;

  if (available <= 0)
    throw { status: 409, message: 'Esta cuota ya tiene pre-cargas pendientes que cubren el saldo total.' };

  const amountReceived = parseFloat(data.amount_received);

  if (amountReceived > available) {
    const totalPending = await queries.getTotalPendingBalance(inst.credit_id);
    if (amountReceived > totalPending)
      throw {
        status: 422,
        message: `El monto ingresado ($${amountReceived.toLocaleString('es-AR')}) supera el saldo total pendiente del crédito ($${totalPending.toLocaleString('es-AR')}).`,
      };
  }

  return queries.create({
    installment_id:     data.installment_id,
    collector_id:       requestingUser.id,
    amount_received:    data.amount_received,
    payment_method:     data.payment_method,
    transfer_reference: data.transfer_reference,
    notes:              data.notes,
  });
};

/**
 * Aprueba una pre-carga y distribuye el monto sobre cuotas futuras si hay excedente.
 * Valida que la caja del día esté abierta antes de procesar.
 * Usa SELECT FOR UPDATE sobre el payment e installment para evitar aprobaciones concurrentes.
 *
 * CAMBIOS DE CONTRATO API: ninguno — misma firma, misma respuesta.
 * Comportamiento nuevo:
 *   · Valida caja abierta (lanza 409 si la caja del día fue cerrada).
 *   · Genera registro en cash_movements dentro de la misma transacción.
 *   · Usa locks transaccionales para serializar aprobaciones simultáneas.
 *
 * @param {string} id      - ID de la pre-carga.
 * @param {string} adminId - Admin que valida el cobro.
 * @returns {Promise<object>} Cobro aprobado con su estado actualizado.
 */
const approve = async (id, adminId) => {
  const today = localDate();

  // Validar caja ANTES de iniciar la transacción (operación de solo lectura)
  await _validateCajaOpen(today);

  await withTransaction(async (client) => {
    // Lock exclusivo sobre el payment para serializar aprobaciones concurrentes
    const payment = await queries.lockAndGetPayment(client, id);
    if (!payment) throw { status: 404, message: 'Cobro no encontrado.' };
    if (payment.status !== 'PENDING')
      throw { status: 409, message: 'Solo se pueden aprobar cobros en estado PENDIENTE.' };

    const amountDue  = parseFloat(payment.amount_due);
    const amountPaid = parseFloat(payment.amount_paid);

    if (amountPaid >= amountDue)
      throw { status: 409, message: 'Esta cuota ya se encuentra totalmente pagada.' };

    // 1. Marcar el payment como APPROVED
    await queries.approve(client, id, adminId);

    // 2. Distribuir el monto sobre la cuota principal y siguientes si hay excedente
    await _applyPaymentToInstallments(client, payment, parseFloat(payment.amount_received), adminId);

    // 3. Registrar movimiento contable en caja
    await _registerCashMovement(client, {
      paymentId:      id,
      amount:         parseFloat(payment.amount_received),
      paymentMethod:  payment.payment_method,
      movementType:   'PAYMENT',
      registerDate:   today,
      userId:         adminId,
    });

    // 4. Verificar si el crédito quedó totalmente liquidado (con lock sobre credits)
    await _checkAndSettleCredit(client, payment.credit_id);
  });

  return queries.findById(id);
};

/**
 * Rechaza una pre-carga. No genera movimiento de caja.
 * @param {string} id              - ID de la pre-carga.
 * @param {string} rejectionReason - Motivo del rechazo.
 * @param {string} adminId         - Admin que rechaza.
 */
const reject = async (id, rejectionReason, adminId) => {
  const payment = await queries.findById(id);
  if (!payment) throw { status: 404, message: 'Cobro no encontrado.' };
  if (payment.status !== 'PENDING')
    throw { status: 409, message: 'Solo se pueden rechazar cobros en estado PENDIENTE.' };
  await queries.reject(id, rejectionReason, adminId);
};

module.exports = {
  getAll, getById, create, approve, reject,
  // Núcleo exportado para reutilización en nuevos flujos (admin-direct, bulk, reverse)
  _validateCajaOpen,
  _applyPaymentToInstallments,
  _checkAndSettleCredit,
  _registerCashMovement,
};
