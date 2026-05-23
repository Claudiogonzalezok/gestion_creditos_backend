const queries = require('./productVariants.queries');
const unitQueries = require('../productUnits/productUnits.queries');
const { withTransaction } = require('../../utils/transaction');

/**
 * Genera un unit_code automático válido para stock inicial.
 * @returns {string} Código de unidad único.
 */
const buildAutoUnitCode = () => {
  const token = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `AUTO-${Date.now()}-${token}`;
};

/**
 * Crea unidades iniciales para una variante dentro de una transacción.
 * @param {object} client - Cliente transaccional de PostgreSQL.
 * @param {string} variantId - ID de la variante recién creada.
 * @param {number} initialUnits - Cantidad de unidades iniciales.
 */
const createInitialUnits = async (client, variantId, initialUnits) => {
  for (let i = 0; i < initialUnits; i += 1) {
    let unitCode = buildAutoUnitCode();
    let existing = await unitQueries.findByUnitCodeForClient(client, unitCode);
    while (existing) {
      unitCode = buildAutoUnitCode();
      existing = await unitQueries.findByUnitCodeForClient(client, unitCode);
    }

    await unitQueries.create(client, {
      variantId,
      unitCode,
      notes: 'Initial stock',
      userId: null,
    });
  }
};

const getAll = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const variant = await queries.findById(id);
  if (!variant) throw { status: 404, message: 'Variante no encontrada.' };
  return variant;
};

const create = async ({ product_id, color, size, capacity, current_price, initial_units }) => {
  const product = await queries.findActiveProductById(product_id);
  if (!product) throw { status: 404, message: 'Producto no encontrado.' };
  if (product.status !== 'ACTIVE')
    throw { status: 409, message: 'No se pueden agregar variantes a un producto inactivo.' };

  const c = color || null, s = size || null, cap = capacity || null;

  if (await queries.findDuplicate(product_id, c, s, cap))
    throw { status: 409, message: 'Ya existe una variante con los mismos atributos para este producto.' };

  const initialUnits = Number.isInteger(Number(initial_units))
    ? Math.max(0, Number(initial_units))
    : 1;

  return withTransaction(async (client) => {
    const variant = await queries.createWithClient(client, {
      productId: product_id,
      color: c,
      size: s,
      capacity: cap,
      currentPrice: current_price,
    });

    if (initialUnits > 0) {
      await createInitialUnits(client, variant.id, initialUnits);
    }

    return variant;
  });
};

/**
 * Crea variantes por lote validando atributos, precio y duplicados por fila.
 * @param {{product_id:string, rows:Array<{color?:string,size?:string,capacity?:string,current_price?:number}>}} payload
 * @returns {Promise<{created: Array<object>, rejected: Array<object>}>}
 */
const createBulk = async ({ product_id, rows }) => {
  const product = await queries.findActiveProductById(product_id);
  if (!product) throw { status: 404, message: 'Producto no encontrado.' };
  if (product.status !== 'ACTIVE') {
    throw { status: 409, message: 'No se pueden agregar variantes a un producto inactivo.' };
  }

  const created = [];
  const errors = [];
  const validRows = [];
  const seen = new Set();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    const color = (row.color || '').trim() || null;
    const size = (row.size || '').trim() || null;
    const capacity = (row.capacity || '').trim() || null;
    const currentPriceRaw = row.current_price;
    const currentPrice = Number(currentPriceRaw);

    const isCompletelyEmpty =
      !color &&
      !size &&
      !capacity &&
      (currentPriceRaw === '' || currentPriceRaw === null || currentPriceRaw === undefined);

    if (isCompletelyEmpty) {
      continue;
    }

    if (!color && !size && !capacity) {
      errors.push({ row: index, field: 'attributes', message: 'Completá al menos color, talle o capacidad.' });
    }

    if (!Number.isFinite(currentPrice) || currentPrice < 0.01) {
      errors.push({ row: index, field: 'current_price', message: 'El precio es obligatorio y debe ser mayor a 0.' });
    }

    const signature = `${color || ''}|${size || ''}|${capacity || ''}`;
    if (seen.has(signature)) {
      errors.push({ row: index, field: 'attributes', message: 'La fila está duplicada dentro del lote.' });
    } else {
      seen.add(signature);
    }

    if (await queries.findDuplicate(product_id, color, size, capacity)) {
      errors.push({ row: index, field: 'attributes', message: 'Ya existe una variante con esos atributos.' });
    }

    if (!errors.some((e) => e.row === index)) {
      const initialUnitsRaw = row.initial_units;
      const initialUnits = Number.isInteger(Number(initialUnitsRaw))
        ? Math.max(0, Number(initialUnitsRaw))
        : 1;
      validRows.push({ color, size, capacity, currentPrice, initialUnits });
    }
  }

  if (errors.length > 0) {
    throw {
      status: 400,
      message: 'Hay filas con datos inválidos. Corregilas y volvé a intentar.',
      errors,
    };
  }

  if (validRows.length === 0) {
    throw {
      status: 400,
      message: 'Debés completar al menos una fila para crear variantes.',
      errors: [{ row: 0, field: 'attributes', message: 'No hay filas con datos para procesar.' }],
    };
  }

  for (const row of validRows) {
    const variant = await withTransaction(async (client) => {
      const createdVariant = await queries.createWithClient(client, {
        productId: product_id,
        color: row.color,
        size: row.size,
        capacity: row.capacity,
        currentPrice: row.currentPrice,
      });

      if (row.initialUnits > 0) {
        await createInitialUnits(client, createdVariant.id, row.initialUnits);
      }

      return createdVariant;
    });
    created.push(variant);
  }

  return { created, rejected: [] };
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

module.exports = { getAll, getById, create, createBulk, update, deactivate, activate };
