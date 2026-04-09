const queries = require('./interestRates.queries');

const getAll = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const rate = await queries.findById(id);
  if (!rate) throw { status: 404, message: 'Tasa no encontrada.' };
  return rate;
};

const create = async (data) => {
  const existing = await queries.findDuplicate(data.credit_type, data.payment_frequency, data.installments_count);
  if (existing) {
    if (!existing.active) return queries.reactivate(existing.id, data.rate);
    throw { status: 409, message: 'Ya existe una tasa activa para esta combinación.' };
  }
  return queries.create(data);
};

const update = async (id, data) => {
  if (!await queries.findById(id)) throw { status: 404, message: 'Tasa no encontrada.' };
  return queries.update(id, data);
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
  const conflict = await queries.findDuplicate(rate.credit_type, rate.payment_frequency, rate.installments_count);
  if (conflict && conflict.id !== id && conflict.active)
    throw { status: 409, message: 'Ya existe una tasa activa para esta combinación.' };
  await queries.activate(id);
};

module.exports = { getAll, getById, create, update, deactivate, activate };
