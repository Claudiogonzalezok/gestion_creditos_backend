const queries = require('./products.queries');

const getAll = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const product = await queries.findById(id);
  if (!product) throw { status: 404, message: 'Producto no encontrado.' };
  return product;
};

const validateCategory = async (category_id) => {
  if (!category_id) return;
  const category = await queries.findActiveCategoryById(category_id);
  if (!category) throw { status: 422, message: 'La categoría seleccionada no existe o está inactiva.' };
};

const create = async ({ description, current_price, category_id }) => {
  if (await queries.findByDescription(description))
    throw { status: 409, message: 'Ya existe un producto registrado con esa descripción.' };
  await validateCategory(category_id);
  return queries.create({ description, current_price, category_id });
};

const update = async (id, { description, current_price, category_id }) => {
  const existing = await queries.findById(id);
  if (!existing) throw { status: 404, message: 'Producto no encontrado.' };

  if (description && description.toLowerCase() !== existing.description.toLowerCase()) {
    if (await queries.findByDescription(description))
      throw { status: 409, message: 'Ya existe un producto registrado con esa descripción.' };
  }

  await validateCategory(category_id);
  return queries.update(id, { description, current_price, category_id });
};

const deactivate = async (id) => {
  const product = await queries.findById(id);
  if (!product) throw { status: 404, message: 'Producto no encontrado.' };
  if (product.status === 'INACTIVE')
    throw { status: 409, message: 'El producto ya está inactivo.' };
  if (await queries.hasActiveCredits(id))
    throw { status: 409, message: 'No se puede desactivar un producto con unidades reservadas o vendidas.' };
  await queries.deactivate(id);
};

const activate = async (id) => {
  const product = await queries.findById(id);
  if (!product) throw { status: 404, message: 'Producto no encontrado.' };
  if (product.status === 'ACTIVE')
    throw { status: 409, message: 'El producto ya está activo.' };
  await queries.activate(id);
};

module.exports = { getAll, getById, create, update, deactivate, activate };
