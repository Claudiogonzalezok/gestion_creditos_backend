const queries = require('./interestRates.queries');

const getAll = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const rate = await queries.findById(id);
  if (!rate) throw { status: 404, message: 'Tasa no encontrada.' };
  return rate;
};

const create = async (data) => {
  const { payment_frequency, installments_count, min_amount, max_amount, rate } = data;

  const exact = await queries.findExact(payment_frequency, installments_count, min_amount, max_amount);
  if (exact) {
    if (!exact.active) return queries.reactivate(exact.id, rate);
    throw { status: 409, message: 'Ya existe una tasa activa para esta combinación y rango de montos.' };
  }

  const overlap = await queries.findOverlap(payment_frequency, installments_count, min_amount, max_amount);
  if (overlap) throw { status: 409, message: 'El rango de montos se superpone con una tasa activa existente.' };

  return queries.create({ payment_frequency, installments_count, min_amount, max_amount, rate });
};

const update = async (id, data) => {
  if (!await queries.findById(id)) throw { status: 404, message: 'Tasa no encontrada.' };
  return queries.update(id, { rate: data.rate ?? null, active: data.active ?? null });
};

const deactivate = async (id) => {
  const rate = await queries.findById(id);
  if (!rate) throw { status: 404, message: 'Tasa no encontrada.' };
  if (!rate.active) throw { status: 409, message: 'La tasa ya está desactivada.' };
  await queries.deactivate(id);
};

const activate = async (id) => {
  const rate = await queries.findById(id);
  if (!rate) throw { status: 404, message: 'Tasa no encontrada.' };
  if (rate.active) throw { status: 409, message: 'La tasa ya está activa.' };

  const overlap = await queries.findOverlap(
    rate.payment_frequency, rate.installments_count,
    rate.min_amount, rate.max_amount, id
  );
  if (overlap) throw { status: 409, message: 'El rango de montos se superpone con una tasa activa existente.' };

  await queries.activate(id);
  return queries.findById(id);
};

module.exports = { getAll, getById, create, update, deactivate, activate };
