const queries = require('./products.queries');

const getAll = async (filters) => {
  return queries.findAll(filters);
};

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

const create = async ({ name, description, current_price, available_stock, category_id }) => {
  if (await queries.findByName(name))
    throw { status: 409, message: 'Ya existe un producto registrado con ese nombre.' };
  await validateCategory(category_id);
  return queries.create({ name, description, current_price, available_stock, category_id });
};

const update = async (id, { name, description, current_price, category_id }) => {
  const existing = await queries.findById(id);
  if (!existing) throw { status: 404, message: 'Producto no encontrado.' };

  if (name && name.toLowerCase() !== existing.name.toLowerCase()) {
    if (await queries.findByName(name))
      throw { status: 409, message: 'Ya existe un producto registrado con ese nombre.' };
  }

  await validateCategory(category_id);
  return queries.update(id, { name, description, current_price, category_id });
};

const adjustStock = async (id, quantity, movement, reason, userId) => {
  const product = await queries.findById(id);
  if (!product) throw { status: 404, message: 'Producto no encontrado.' };
  if (product.status !== 'ACTIVE')
    throw { status: 409, message: 'No se puede ajustar el stock de un producto inactivo.' };

  // Si es salida, verificar que haya stock suficiente
  if (movement === 'OUT' && product.available_stock < quantity)
    throw {
      status: 409,
      message: `Stock insuficiente. Disponible: ${product.available_stock} unidades.`,
    };

  return queries.adjustStock(id, quantity, movement, reason, userId);
};

const deactivate = async (id) => {
  const product = await queries.findById(id);
  if (!product) throw { status: 404, message: 'Producto no encontrado.' };
  if (product.status === 'INACTIVE')
    throw { status: 409, message: 'El producto ya está inactivo.' };
  if (await queries.hasActiveCredits(id))
    throw { status: 409, message: 'No se puede desactivar un producto con créditos activos asociados.' };
  await queries.deactivate(id);
};

const activate = async (id) => {
  const product = await queries.findById(id);
  if (!product) throw { status: 404, message: 'Producto no encontrado.' };
  if (product.status === 'ACTIVE')
    throw { status: 409, message: 'El producto ya está activo.' };
  await queries.activate(id);
};

module.exports = { getAll, getById, create, update, adjustStock, deactivate, activate };
