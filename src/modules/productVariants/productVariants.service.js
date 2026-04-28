const queries = require('./productVariants.queries');

const getAll = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const variant = await queries.findById(id);
  if (!variant) throw { status: 404, message: 'Variante no encontrada.' };
  return variant;
};

const create = async ({ product_id, color, size, capacity, current_price }) => {
  const product = await queries.findActiveProductById(product_id);
  if (!product) throw { status: 404, message: 'Producto no encontrado.' };
  if (product.status !== 'ACTIVE')
    throw { status: 409, message: 'No se pueden agregar variantes a un producto inactivo.' };

  return queries.create({
    productId:    product_id,
    color:        color    || null,
    size:         size     || null,
    capacity:     capacity || null,
    currentPrice: current_price,
  });
};

const update = async (id, { color, size, capacity, current_price }) => {
  const variant = await queries.findById(id);
  if (!variant) throw { status: 404, message: 'Variante no encontrada.' };

  return queries.update(id, {
    color,
    size,
    capacity,
    currentPrice: current_price,
  });
};

const deactivate = async (id) => {
  const variant = await queries.findById(id);
  if (!variant) throw { status: 404, message: 'Variante no encontrada.' };
  if (variant.status === 'INACTIVE')
    throw { status: 409, message: 'La variante ya está inactiva.' };
  if (await queries.hasActiveUnits(id))
    throw { status: 409, message: 'No se puede desactivar una variante con unidades disponibles, reservadas o vendidas.' };
  await queries.deactivate(id);
};

const activate = async (id) => {
  const variant = await queries.findById(id);
  if (!variant) throw { status: 404, message: 'Variante no encontrada.' };
  if (variant.status === 'ACTIVE')
    throw { status: 409, message: 'La variante ya está activa.' };
  await queries.activate(id);
};

module.exports = { getAll, getById, create, update, deactivate, activate };
