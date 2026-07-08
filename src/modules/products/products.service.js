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

const validateBrand = async (brand_id) => {
  if (!brand_id) return;
  const brand = await queries.findActiveBrandById(brand_id);
  if (!brand) throw { status: 422, message: 'La marca seleccionada no existe o está inactiva.' };
};

const create = async ({ title, description, model, brand_id, category_id }) => {
  if (await queries.findByTitle(title))
    throw { status: 409, message: 'Ya existe un producto registrado con ese título.' };
  await validateCategory(category_id);
  await validateBrand(brand_id);
  return queries.create({ title, description, model, brand_id, category_id });
};

const update = async (id, { title, description, model, brand_id, category_id }) => {
  const existing = await queries.findById(id);
  if (!existing) throw { status: 404, message: 'Producto no encontrado.' };

  if (title && title.toLowerCase() !== existing.title.toLowerCase()) {
    if (await queries.findByTitle(title))
      throw { status: 409, message: 'Ya existe un producto registrado con ese título.' };
  }

  await validateCategory(category_id);
  await validateBrand(brand_id);
  return queries.update(id, { title, description, model, brand_id, category_id });
};

/**
 * Desactiva un producto. Si `force` es true, permite desactivar aunque tenga
 * unidades vendidas; solo bloquea si hay unidades reservadas (créditos activos pendientes).
 * @param {string} id
 * @param {boolean} force
 */
const deactivate = async (id, force = false) => {
  const product = await queries.findById(id);
  if (!product) throw { status: 404, message: 'Producto no encontrado.' };
  if (product.status === 'INACTIVE')
    throw { status: 409, message: 'El producto ya está inactivo.' };
  if (!force && await queries.hasActiveCredits(id))
    throw { status: 409, message: 'El producto tiene unidades reservadas en créditos activos. Usá la opción de desactivación forzada para ignorar unidades ya vendidas.' };
  if (force && await queries.hasReservedUnits(id))
    throw { status: 409, message: 'No se puede desactivar: el producto tiene unidades reservadas en créditos pendientes de aprobación.' };
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
