const queries = require('./productCategories.queries');

const getAll = async ({ includeInactive } = {}) => {
  return queries.findAll({ includeInactive });
};

const create = async ({ name }) => {
  const existing = await queries.findByName(name);
  if (existing) throw { status: 409, message: 'Ya existe una categoría con ese nombre.' };
  return queries.create({ name });
};

const activate = async (id) => {
  const category = await queries.findById(id);
  if (!category) throw { status: 404, message: 'Categoría no encontrada.' };
  await queries.activate(id);
};

const deactivate = async (id) => {
  const category = await queries.findById(id);
  if (!category) throw { status: 404, message: 'Categoría no encontrada.' };
  await queries.deactivate(id);
};

module.exports = { getAll, create, activate, deactivate };
