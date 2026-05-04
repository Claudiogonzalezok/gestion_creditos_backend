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

  const c = color || null, s = size || null, cap = capacity || null;

  if (await queries.findDuplicate(product_id, c, s, cap))
    throw { status: 409, message: 'Ya existe una variante con los mismos atributos para este producto.' };

  return queries.create({ productId: product_id, color: c, size: s, capacity: cap, currentPrice: current_price });
};

const update = async (id, { color, size, capacity, current_price }) => {
  const variant = await queries.findById(id);
  if (!variant) throw { status: 404, message: 'Variante no encontrada.' };

  // Valores resultantes tras aplicar el update (undefined = no cambia)
  const resultColor    = color    !== undefined ? (color    || null) : variant.color;
  const resultSize     = size     !== undefined ? (size     || null) : variant.size;
  const resultCapacity = capacity !== undefined ? (capacity || null) : variant.capacity;

  if (!resultColor && !resultSize && !resultCapacity)
    throw { status: 409, message: 'La variante debe mantener al menos un atributo: color, talle o capacidad.' };

  if (await queries.findDuplicate(variant.product_id, resultColor, resultSize, resultCapacity, id))
    throw { status: 409, message: 'Ya existe una variante con los mismos atributos para este producto.' };

  return queries.update(id, { color, size, capacity, currentPrice: current_price });
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
