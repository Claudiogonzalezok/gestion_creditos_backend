const pool    = require('../../config/db');
const queries = require('./productUnits.queries');
const { withTransaction } = require('../../utils/transaction');

const getAll = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const unit = await queries.findById(id);
  if (!unit) throw { status: 404, message: 'Unidad no encontrada.' };
  return unit;
};

// Alta de una sola unidad
const create = async ({ productId, unitCode, notes }, userId) => {
  const productCheck = await pool.query(
    `SELECT id, status FROM products WHERE id = $1`, [productId]
  );
  if (!productCheck.rows.length)
    throw { status: 404, message: 'Producto no encontrado.' };
  if (productCheck.rows[0].status !== 'ACTIVE')
    throw { status: 409, message: 'No se puede agregar unidades a un producto inactivo.' };

  if (await queries.findByUnitCode(unitCode))
    throw { status: 409, message: `Ya existe una unidad con el código "${unitCode}".` };

  return withTransaction(async (client) => {
    const unit = await queries.create(client, { productId, unitCode, notes, userId });
    const full = await queries.findById(unit.id);
    return full;
  });
};

// Alta masiva: array de { unitCode, notes }
const createBulk = async (productId, units, userId) => {
  const productCheck = await pool.query(
    `SELECT id, status FROM products WHERE id = $1`, [productId]
  );
  if (!productCheck.rows.length)
    throw { status: 404, message: 'Producto no encontrado.' };
  if (productCheck.rows[0].status !== 'ACTIVE')
    throw { status: 409, message: 'No se puede agregar unidades a un producto inactivo.' };

  return withTransaction(async (client) => {
    const created = [];
    for (const u of units) {
      const existing = await queries.findByUnitCodeForClient(client, u.unit_code);
      if (existing)
        throw { status: 409, message: `Ya existe una unidad con el código "${u.unit_code}".` };
      const unit = await queries.create(client, {
        productId, unitCode: u.unit_code, notes: u.notes, userId,
      });
      created.push(unit);
    }
    return { created: created.length, units: created };
  });
};

// Actualizar código o notas (solo si está AVAILABLE o INACTIVE)
const update = async (id, { unitCode, notes }) => {
  const unit = await queries.findById(id);
  if (!unit) throw { status: 404, message: 'Unidad no encontrada.' };
  if (['RESERVED','SOLD'].includes(unit.status))
    throw { status: 409, message: 'No se puede modificar una unidad que está reservada o vendida.' };

  if (unitCode && unitCode !== unit.unit_code) {
    if (await queries.findByUnitCode(unitCode))
      throw { status: 409, message: `Ya existe una unidad con el código "${unitCode}".` };
  }

  return queries.update(id, { unitCode, notes });
};

// Dar de baja una unidad (solo si está AVAILABLE)
const deactivate = async (id, userId) => {
  const unit = await queries.findById(id);
  if (!unit) throw { status: 404, message: 'Unidad no encontrada.' };
  if (unit.status !== 'AVAILABLE')
    throw {
      status: 409,
      message: unit.status === 'SOLD'
        ? 'No se puede dar de baja una unidad ya vendida.'
        : unit.status === 'RESERVED'
        ? 'No se puede dar de baja una unidad reservada en un crédito pendiente.'
        : 'La unidad ya está inactiva.',
    };

  await withTransaction(async (client) => {
    await queries.updateStatus(client, id, 'INACTIVE');
    await client.query(
      `INSERT INTO stock_movements (product_id, product_unit_id, movement, quantity, reason, user_id)
       VALUES ($1, $2, 'OUT', 1, 'Baja de unidad', $3)`,
      [unit.product_id, id, userId || null]
    );
  });
};

// Reactivar una unidad dada de baja
const activate = async (id) => {
  const unit = await queries.findById(id);
  if (!unit) throw { status: 404, message: 'Unidad no encontrada.' };
  if (unit.status !== 'INACTIVE')
    throw { status: 409, message: 'Solo se pueden reactivar unidades inactivas.' };

  await withTransaction(async (client) => {
    await queries.updateStatus(client, id, 'AVAILABLE');
  });
};

module.exports = { getAll, getById, create, createBulk, update, deactivate, activate };
