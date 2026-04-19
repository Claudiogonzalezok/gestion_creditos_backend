const pool    = require('../../config/db');
const queries = require('./productRates.queries');

const getAll = async (productId) => queries.findAll(productId || null);

const getById = async (id) => {
  const rate = await queries.findById(id);
  if (!rate) throw { status: 404, message: 'Tasa de producto no encontrada.' };
  return rate;
};

const create = async (data) => {
  // Validar que el producto exista y esté activo
  const prod = await pool.query(
    `SELECT id, status FROM products WHERE id = $1`, [data.product_id]
  );
  if (!prod.rows.length)
    throw { status: 404, message: 'Producto no encontrado.' };
  if (prod.rows[0].status !== 'ACTIVE')
    throw { status: 409, message: 'No se puede configurar una tasa para un producto inactivo.' };

  return queries.create(data);
};

const update = async (id, data) => {
  const existing = await queries.findById(id);
  if (!existing) throw { status: 404, message: 'Tasa de producto no encontrada.' };
  return queries.update(id, data);
};

const deactivate = async (id) => {
  const existing = await queries.findById(id);
  if (!existing) throw { status: 404, message: 'Tasa de producto no encontrada.' };
  if (!existing.active) throw { status: 409, message: 'La tasa ya está desactivada.' };
  return queries.update(id, { active: false });
};

const activate = async (id) => {
  const existing = await queries.findById(id);
  if (!existing) throw { status: 404, message: 'Tasa de producto no encontrada.' };
  if (existing.active) throw { status: 409, message: 'La tasa ya está activa.' };
  return queries.update(id, { active: true });
};

module.exports = { getAll, getById, create, update, deactivate, activate };
