const pool    = require('../../config/db');
const queries = require('./productUnits.queries');
const { withTransaction } = require('../../utils/transaction');

const assertVariantActive = async (variantId) => {
  const r = await pool.query(
    `SELECT pv.status, p.status AS product_status
     FROM product_variants pv
     JOIN products p ON p.id = pv.product_id
     WHERE pv.id = $1`,
    [variantId]
  );
  if (!r.rows.length)
    throw { status: 404, message: 'Variante no encontrada.' };
  if (r.rows[0].status !== 'ACTIVE')
    throw { status: 409, message: 'No se pueden agregar unidades a una variante inactiva.' };
  if (r.rows[0].product_status !== 'ACTIVE')
    throw { status: 409, message: 'No se pueden agregar unidades a un producto inactivo.' };
};

const getAll = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const unit = await queries.findById(id);
  if (!unit) throw { status: 404, message: 'Unidad no encontrada.' };
  return unit;
};

const create = async ({ variantId, unitCode, notes }, userId) => {
  await assertVariantActive(variantId);

  if (await queries.findByUnitCode(unitCode))
    throw { status: 409, message: `Ya existe una unidad con el código "${unitCode}".` };

  return withTransaction(async (client) => {
    const unit = await queries.create(client, { variantId, unitCode, notes, userId });
    return queries.findById(unit.id);
  });
};

const createBulk = async (variantId, units, userId) => {
  await assertVariantActive(variantId);

  // Verificar duplicados internos en el batch antes de ir a la DB
  const codes = units.map(u => u.unit_code);
  const uniqueCodes = new Set(codes);
  if (uniqueCodes.size !== codes.length)
    throw { status: 409, message: 'El listado contiene códigos de unidad duplicados.' };

  return withTransaction(async (client) => {
    const created = [];
    for (const u of units) {
      const existing = await queries.findByUnitCodeForClient(client, u.unit_code);
      if (existing)
        throw { status: 409, message: `Ya existe una unidad con el código "${u.unit_code}".` };
      const unit = await queries.create(client, {
        variantId, unitCode: u.unit_code, notes: u.notes, userId,
      });
      created.push(unit);
    }
    return { created: created.length, units: created };
  });
};

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
