const queries         = require('./installments.queries');
const paymentsQueries = require('../payments/payments.queries');
const { getValue }    = require('../systemConfig/systemConfig.queries');
const { withTransaction } = require('../../utils/transaction');

const getAll = async (filters, requestingUser) => {
  if (['COLLECTOR','SELLER_COLLECTOR'].includes(requestingUser.role))
    filters = { ...filters, collector_id: requestingUser.id };
  return queries.findAll(filters);
};

const getById = async (id) => {
  const inst = await queries.findById(id);
  if (!inst) throw { status: 404, message: 'Cuota no encontrada.' };
  return inst;
};

const applyPenalty = async (id, penaltyAmount) => {
  const inst = await queries.findById(id);
  if (!inst)                    throw { status: 404, message: 'Cuota no encontrada.' };
  if (inst.status === 'PAID')   throw { status: 409, message: 'No se puede aplicar mora a una cuota ya pagada.' };
  if (inst.status === 'PENDING') throw { status: 409, message: 'La cuota aún no está vencida. Solo se aplica mora a cuotas OVERDUE.' };

  const maxRate      = parseFloat(await getValue('penalty_max_rate') || '0.50');
  const original     = parseFloat(inst.amount_due) - parseFloat(inst.penalty_amount);
  const maxPenalty   = original * maxRate;
  const currentPenalty = parseFloat(inst.penalty_amount);

  if (currentPenalty >= maxPenalty)
    throw { status: 409, message: `La mora ya alcanzó el tope máximo (${maxRate * 100}% del monto original).` };

  const applicable = Math.min(penaltyAmount, maxPenalty - currentPenalty);
  return queries.applyPenalty(id, applicable);
};

const waivePenalty = async (id) => {
  const inst = await queries.findById(id);
  if (!inst) throw { status: 404, message: 'Cuota no encontrada.' };
  if (parseFloat(inst.penalty_amount) === 0)
    throw { status: 409, message: 'Esta cuota no tiene mora aplicada.' };
  return queries.waivePenalty(id);
};

const earlyPay = async (id, paymentMethod, transferReference, adminId) => {
  const inst = await queries.findById(id);
  if (!inst) throw { status: 404, message: 'Cuota no encontrada.' };
  if (inst.status === 'PAID')
    throw { status: 409, message: 'Esta cuota ya fue pagada.' };

  // Verificar que no haya pre-cargas PENDING pendientes de aprobación
  const pendingAmount = await paymentsQueries.getPendingCommittedAmount(id);
  if (pendingAmount > 0)
    throw { status: 409, message: 'Hay pre-cargas pendientes de aprobación para esta cuota. Aprobá o rechazalas antes de aplicar un pago anticipado.' };

  let settled = false;
  await withTransaction(async (client) => {
    const paidInst = await queries.earlyPay(client, id, adminId, paymentMethod, transferReference);

    // Verificar si el crédito quedó totalmente liquidado
    const remaining = await paymentsQueries.countPendingInstallments(client, paidInst.credit_id);
    if (remaining === 0) {
      await paymentsQueries.settleCredit(client, paidInst.credit_id);
      settled = true;
    }
  });

  return {
    ...(await queries.findById(id)),
    credit_settled: settled,
  };
};

module.exports = { getAll, getById, applyPenalty, waivePenalty, earlyPay };
