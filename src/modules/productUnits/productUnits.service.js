const pool    = require('../../config/db');
const queries = require('./productUnits.queries');
const { withTransaction } = require('../../utils/transaction');

// Tope de unidades por alta masiva (#38), igual al de initial_units en variantes.
// Se valida también en el middleware.
const MAX_BULK_UNITS = 10000;

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

/**
 * Construye el error 409 para un unit_code ya existente, distinguiendo si
 * pertenece a una unidad dada de baja (no reutilizable) o a una vigente.
 * @param {string} unitCode - Código en conflicto.
 * @param {{status:string}} existing - Unidad encontrada con ese código.
 * @returns {{status:number, message:string}}
 */
const unitCodeConflictError = (unitCode, existing) => ({
  status: 409,
  message: existing.status === 'INACTIVE'
    ? `El código "${unitCode}" pertenece a una unidad dada de baja y no puede reutilizarse.`
    : `Ya existe una unidad con el código "${unitCode}".`,
});

const getAll = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const unit = await queries.findById(id);
  if (!unit) throw { status: 404, message: 'Unidad no encontrada.' };
  return unit;
};

const create = async ({ variantId, unitCode, notes }, userId) => {
  await assertVariantActive(variantId);

  const existing = await queries.findByUnitCode(unitCode);
  if (existing) throw unitCodeConflictError(unitCode, existing);

  // findById se llama fuera de la transacción para que lea datos ya committeados
  const inserted = await withTransaction(async (client) => {
    return queries.create(client, { variantId, unitCode, notes, userId });
  });
  return queries.findById(inserted.id);
};

const createBulk = async (variantId, units, userId) => {
  if (!Array.isArray(units) || units.length > MAX_BULK_UNITS)
    throw { status: 400, message: `Se pueden registrar hasta ${MAX_BULK_UNITS} unidades por lote.` };
  await assertVariantActive(variantId);

  // Verificar duplicados internos en el batch antes de ir a la DB
  const codes = units.map(u => u.unit_code);
  const uniqueCodes = new Set(codes);
  if (uniqueCodes.size !== codes.length)
    throw { status: 409, message: 'El listado contiene códigos de unidad duplicados.' };

  // Se guardan solo los ids dentro de la transacción; findById corre después del COMMIT
  const insertedIds = await withTransaction(async (client) => {
    const ids = [];
    for (const u of units) {
      const existing = await queries.findByUnitCodeForClient(client, u.unit_code);
      if (existing) throw unitCodeConflictError(u.unit_code, existing);
      const unit = await queries.create(client, {
        variantId, unitCode: u.unit_code, notes: u.notes, userId,
      });
      ids.push(unit.id);
    }
    return ids;
  });

  const fullUnits = await Promise.all(insertedIds.map(id => queries.findById(id)));
  return { created: fullUnits.length, units: fullUnits };
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

const activate = async (id, userId) => {
  const unit = await queries.findById(id);
  if (!unit) throw { status: 404, message: 'Unidad no encontrada.' };
  if (unit.status !== 'INACTIVE')
    throw { status: 409, message: 'Solo se pueden reactivar unidades inactivas.' };

  await withTransaction(async (client) => {
    await queries.updateStatus(client, id, 'AVAILABLE');
    await client.query(
      `INSERT INTO stock_movements (product_id, product_unit_id, movement, quantity, reason, user_id)
       VALUES ($1, $2, 'IN', 1, 'Reactivación de unidad', $3)`,
      [unit.product_id, id, userId || null]
    );
  });
};

module.exports = { MAX_BULK_UNITS, getAll, getById, create, createBulk, update, deactivate, activate };
