const pool    = require('../../config/db');
const queries = require('./payments.queries');
const { withTransaction } = require('../../utils/transaction');

const getAll = async (filters, requestingUser) => {
  if (['COLLECTOR','SELLER_COLLECTOR'].includes(requestingUser.role))
    filters = { ...filters, collector_id: requestingUser.id };
  return queries.findAll(filters);
};

const getById = async (id) => {
  const payment = await queries.findById(id);
  if (!payment) throw { status: 404, message: 'Cobro no encontrado.' };
  return payment;
};

const create = async (data, requestingUser) => {
  // Verificar que la cuota exista y tenga saldo pendiente
  const instCheck = await pool.query(
    `SELECT id, status, amount_due::float8, amount_paid::float8, credit_id FROM installments WHERE id = $1`,
    [data.installment_id]
  );
  if (!instCheck.rows.length) throw { status: 404, message: 'Cuota no encontrada.' };
  const inst = instCheck.rows[0];
  if (inst.status === 'PAID') throw { status: 409, message: 'Esta cuota ya fue pagada.' };

  // Calcular saldo disponible en la cuota descontando pre-cargas PENDING ya registradas
  const amountDue     = inst.amount_due;
  const amountPaid    = inst.amount_paid;
  const pendingAmount = await queries.getPendingCommittedAmount(data.installment_id);
  const available     = amountDue - amountPaid - pendingAmount;

  if (available <= 0)
    throw { status: 409, message: 'Esta cuota ya tiene pre-cargas pendientes que cubren el saldo total.' };

  const amountReceived = parseFloat(data.amount_received);

  // Permitir que el monto supere la cuota actual (adelanto de cuotas):
  // el límite superior es el saldo total pendiente del crédito completo.
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

const approve = async (id, adminId) => {
  const payment = await queries.findById(id);
  if (!payment) throw { status: 404, message: 'Cobro no encontrado.' };
  if (payment.status !== 'PENDING')
    throw { status: 409, message: 'Solo se pueden aprobar cobros en estado PENDIENTE.' };

  const amountDue      = parseFloat(payment.amount_due);
  const amountPaid     = parseFloat(payment.amount_paid);
  const amountReceived = parseFloat(payment.amount_received);

  if (amountPaid >= amountDue)
    throw { status: 409, message: 'Esta cuota ya se encuentra totalmente pagada.' };

  await withTransaction(async (client) => {
    await queries.approve(client, id, adminId);

    // Aplicar el monto recibido a la cuota principal
    const newInstStatus = await queries.updateInstallment(
      client,
      payment.installment_id,
      amountReceived,
      amountDue,
      amountPaid
    );

    const round = (n) => Math.round(n * 100) / 100;
    let remaining = round(amountReceived - (amountDue - amountPaid));
    let paidCount = 0; // cuotas adelantadas (aparte de la cuota principal)

    // Si sobra saldo, aplicar a cuotas siguientes (adelanto)
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
          // Cubre esta cuota completa → marcar como PAID con nota de adelanto
          await queries.markInstallmentAsPrepaid(
            client,
            inst.id,
            adminId,
            'Pago adelantado',
            payment.payment_method
          );
          remaining = round(remaining - instBalance);
          paidCount++;
        } else {
          // Cubre solo parcialmente → actualizar amount_paid
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

    // Si se adelantaron cuotas completas, reasignar fechas de las restantes
    // desde hoy + 1 período (la siguiente cuota siempre vence el mes/semana que viene)
    if (paidCount > 0) {
      await queries.shiftInstallmentDates(
        client,
        payment.credit_id,
        payment.payment_frequency,
        payment.due_date
      );
    }

    // Verificar si el crédito quedó totalmente liquidado
    const pendingCount = await queries.countPendingInstallments(client, payment.credit_id);
    if (pendingCount === 0) await queries.settleCredit(client, payment.credit_id);
  });

  return queries.findById(id);
};

const reject = async (id, rejectionReason, adminId) => {
  const payment = await queries.findById(id);
  if (!payment) throw { status: 404, message: 'Cobro no encontrado.' };
  if (payment.status !== 'PENDING')
    throw { status: 409, message: 'Solo se pueden rechazar cobros en estado PENDIENTE.' };
  await queries.reject(id, rejectionReason, adminId);
};

module.exports = { getAll, getById, create, approve, reject };
