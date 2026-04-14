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
    `SELECT id, status, amount_due, amount_paid, credit_id FROM installments WHERE id = $1`,
    [data.installment_id]
  );
  if (!instCheck.rows.length) throw { status: 404, message: 'Cuota no encontrada.' };
  const inst = instCheck.rows[0];
  if (inst.status === 'PAID') throw { status: 409, message: 'Esta cuota ya fue pagada.' };

  // Calcular saldo disponible descontando pre-cargas PENDING ya registradas
  const amountDue      = parseFloat(inst.amount_due);
  const amountPaid     = parseFloat(inst.amount_paid);
  const pendingAmount  = await queries.getPendingCommittedAmount(data.installment_id);
  const available      = amountDue - amountPaid - pendingAmount;

  if (available <= 0)
    throw { status: 409, message: 'Esta cuota ya tiene pre-cargas pendientes que cubren el saldo total.' };

  const amountReceived = parseFloat(data.amount_received);
  if (amountReceived > available)
    throw { status: 422, message: `El monto ingresado ($${amountReceived.toLocaleString('es-AR')}) supera el saldo disponible ($${available.toLocaleString('es-AR')}).` };

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

  // Verificar que la cuota aún tenga saldo pendiente
  const amountDue  = parseFloat(payment.amount_due);
  const amountPaid = parseFloat(payment.amount_paid);
  if (amountPaid >= amountDue)
    throw { status: 409, message: 'Esta cuota ya se encuentra totalmente pagada.' };

  await withTransaction(async (client) => {
    await queries.approve(client, id, adminId);

    const newInstStatus = await queries.updateInstallment(
      client,
      payment.installment_id,
      parseFloat(payment.amount_received),
      amountDue,
      amountPaid
    );

    // Si la cuota quedó PAID, verificar si el crédito está liquidado
    if (newInstStatus === 'PAID') {
      const remaining = await queries.countPendingInstallments(client, payment.credit_id);
      if (remaining === 0) await queries.settleCredit(client, payment.credit_id);
    }
  });

  // Leemos DESPUÉS del COMMIT para reflejar el estado actualizado
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
