const queries = require('./productBrands.queries');

const getAll = async (includeInactive) => queries.findAll(includeInactive);

const getById = async (id) => {
  const brand = await queries.findById(id);
  if (!brand) throw { status: 404, message: 'Marca no encontrada.' };
  return brand;
};

const create = async (name) => {
  if (await queries.findByName(name))
    throw { status: 409, message: 'Ya existe una marca registrada con ese nombre.' };
  return queries.create(name);
};

const deactivate = async (id) => {
  const brand = await queries.findById(id);
  if (!brand) throw { status: 404, message: 'Marca no encontrada.' };
  if (!brand.active) throw { status: 409, message: 'La marca ya está inactiva.' };
  await queries.deactivate(id);
};

const activate = async (id) => {
  const brand = await queries.findById(id);
  if (!brand) throw { status: 404, message: 'Marca no encontrada.' };
  if (brand.active) throw { status: 409, message: 'La marca ya está activa.' };
  await queries.activate(id);
};

module.exports = { getAll, getById, create, deactivate, activate };
