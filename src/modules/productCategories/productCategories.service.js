const queries = require('./productCategories.queries');

const getAll = async ({ includeInactive } = {}) => {
  return queries.findAll({ includeInactive });
};

const create = async ({ name }) => {
  if (await queries.findByName(name))
    throw { status: 409, message: 'Ya existe una categoría con ese nombre.' };
  return queries.create({ name });
};

const update = async (id, name) => {
  const category = await queries.findById(id);
  if (!category) throw { status: 404, message: 'Categoría no encontrada.' };
  if (category.name.toLowerCase() === name.toLowerCase()) return category;
  if (await queries.findByName(name))
    throw { status: 409, message: 'Ya existe una categoría con ese nombre.' };
  return queries.update(id, name);
};

const activate = async (id) => {
  const category = await queries.findById(id);
  if (!category) throw { status: 404, message: 'Categoría no encontrada.' };
  if (category.active) throw { status: 409, message: 'La categoría ya está activa.' };
  await queries.activate(id);
};

const deactivate = async (id) => {
  const category = await queries.findById(id);
  if (!category) throw { status: 404, message: 'Categoría no encontrada.' };
  if (!category.active) throw { status: 409, message: 'La categoría ya está inactiva.' };
  if (await queries.hasActiveProducts(id))
    throw { status: 409, message: 'No se puede desactivar una categoría con productos activos asociados.' };
  await queries.deactivate(id);
};

module.exports = { getAll, create, update, activate, deactivate };
