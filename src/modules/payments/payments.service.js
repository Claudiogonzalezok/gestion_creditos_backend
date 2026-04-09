const pool    = require('../../config/db');
const queries = require('./payments.queries');
const { withTransaction } = require('../../utils/transaction');

const getAll = async (filters, requestingUser) => {
  if (requestingUser.role === 'COLLECTOR')
    filters = { ...filters, collector_id: requestingUser.id };
  return queries.findAll(filters);
};

const getById = async (id) => {
  const payment = await queries.findById(id);
  if (!payment) throw { status: 404, message: 'Cobro no encontrado.' };
  return payment;
};

const create = async (data, requestingUser) => {
  // Verificar que la cuota exista y esté pendiente
  const instCheck = await pool.query(
    `SELECT id, status, amount_due, credit_id FROM installments WHERE id = $1`,
    [data.installment_id]
  );
  if (!instCheck.rows.length) throw { status: 404, message: 'Cuota no encontrada.' };
  const inst = instCheck.rows[0];
  if (inst.status === 'PAID') throw { status: 409, message: 'Esta cuota ya fue pagada.' };

  // Advertir si ya hay una pre-carga pendiente (no bloquea, solo alerta en la respuesta)
  const hasPending = await queries.hasPendingPayment(data.installment_id);

  const payment = await queries.create({
    installment_id:     data.installment_id,
    collector_id:       requestingUser.id,
    amount_received:    data.amount_received,
    payment_method:     data.payment_method,
    transfer_reference: data.transfer_reference,
    notes:              data.notes,
  });

  return {
    ...payment,
    warning: hasPending ? 'Ya existía una pre-carga pendiente para esta cuota. El Admin resolverá el conflicto.' : undefined,
  };
};

const approve = async (id, adminId) => {
  const payment = await queries.findById(id);
  if (!payment) throw { status: 404, message: 'Cobro no encontrado.' };
  if (payment.status !== 'PENDING')
    throw { status: 409, message: 'Solo se pueden aprobar cobros en estado PENDIENTE.' };

  return withTransaction(async (client) => {
    await queries.approve(client, id, adminId);

    const newInstStatus = await queries.updateInstallment(
      client,
      payment.installment_id,
      parseFloat(payment.amount_received),
      parseFloat(payment.amount_due)
    );

    // Si la cuota quedó PAID, verificar si el crédito está liquidado
    if (newInstStatus === 'PAID') {
      const remaining = await queries.countPendingInstallments(client, payment.credit_id);
      if (remaining === 0) await queries.settleCredit(client, payment.credit_id);
    }

    return queries.findById(id);
  });
};

const reject = async (id, rejectionReason, adminId) => {
  const payment = await queries.findById(id);
  if (!payment) throw { status: 404, message: 'Cobro no encontrado.' };
  if (payment.status !== 'PENDING')
    throw { status: 409, message: 'Solo se pueden rechazar cobros en estado PENDIENTE.' };
  await queries.reject(id, rejectionReason, adminId);
};

module.exports = { getAll, getById, create, approve, reject };
