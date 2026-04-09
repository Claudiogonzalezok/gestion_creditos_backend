const queries      = require('./installments.queries');
const { getValue } = require('../systemConfig/systemConfig.queries');

const getAll = async (filters, requestingUser) => {
  if (requestingUser.role === 'COLLECTOR')
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

module.exports = { getAll, getById, applyPenalty, waivePenalty };
