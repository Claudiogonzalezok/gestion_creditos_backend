const pool = require('../../config/db');

const findAll = async ({ variantId, productId, status, search } = {}) => {
  let q = `
    SELECT pu.id, pu.unit_code, pu.status, pu.notes, pu.created_at, pu.updated_at,
           pv.id    AS variant_id,  pv.color, pv.size, pv.capacity,
           pv.current_price::float8,
           p.id     AS product_id,  p.title AS product_name
    FROM product_units pu
    JOIN product_variants pv ON pv.id = pu.variant_id
    JOIN products p          ON p.id  = pv.product_id
    WHERE 1=1`;
  const params = [];
  if (variantId) { params.push(variantId);      q += ` AND pu.variant_id = $${params.length}`; }
  if (productId) { params.push(productId);      q += ` AND pv.product_id = $${params.length}`; }
  if (status)    { params.push(status);         q += ` AND pu.status = $${params.length}`; }
  if (search)    { params.push(`%${search}%`);  q += ` AND pu.unit_code ILIKE $${params.length}`; }
  q += ` ORDER BY p.title ASC, pu.unit_code ASC`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT pu.id, pu.unit_code, pu.status, pu.notes, pu.created_at, pu.updated_at,
            pv.id    AS variant_id,  pv.color, pv.size, pv.capacity,
            pv.current_price::float8,
            p.id     AS product_id,  p.title AS product_name
     FROM product_units pu
     JOIN product_variants pv ON pv.id = pu.variant_id
     JOIN products p          ON p.id  = pv.product_id
     WHERE pu.id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

// Solo busca unidades activas: los códigos de unidades INACTIVE pueden reutilizarse
const findByUnitCode = async (unitCode) => {
  const r = await pool.query(
    `SELECT id FROM product_units WHERE unit_code = $1 AND status != 'INACTIVE'`, [unitCode]
  );
  return r.rows[0] || null;
};

// Versión transaccional de findByUnitCode para uso en bulk create
const findByUnitCodeForClient = async (client, unitCode) => {
  const r = await client.query(
    `SELECT id FROM product_units WHERE unit_code = $1 AND status != 'INACTIVE'`, [unitCode]
  );
  return r.rows[0] || null;
};

// Crea una unidad y registra el movimiento IN (obtiene product_id desde la variante)
const create = async (client, { variantId, unitCode, notes, userId }) => {
  const varRes = await client.query(
    `SELECT product_id FROM product_variants WHERE id = $1`, [variantId]
  );
  const productId = varRes.rows[0]?.product_id || null;

  const r = await client.query(
    `INSERT INTO product_units (variant_id, unit_code, notes)
     VALUES ($1, $2, $3)
     RETURNING id, unit_code, status, notes, created_at`,
    [variantId, unitCode, notes || null]
  );
  const unit = r.rows[0];

  if (productId) {
    await client.query(
      `INSERT INTO stock_movements (product_id, product_unit_id, movement, quantity, reason, user_id)
       VALUES ($1, $2, 'IN', 1, 'Alta de unidad', $3)`,
      [productId, unit.id, userId || null]
    );
  }
  return unit;
};

const update = async (id, { unitCode, notes }) => {
  const r = await pool.query(
    `UPDATE product_units
     SET unit_code  = COALESCE($1, unit_code),
         notes      = COALESCE($2, notes),
         updated_at = NOW()
     WHERE id = $3
     RETURNING id, unit_code, status, notes, updated_at`,
    [unitCode || null, notes !== undefined ? notes : null, id]
  );
  return r.rows[0] || null;
};

const updateStatus = async (client, id, status) => {
  await client.query(
    `UPDATE product_units SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, id]
  );
};

const updateStatusBulk = async (client, ids, status) => {
  await client.query(
    `UPDATE product_units SET status = $1, updated_at = NOW() WHERE id = ANY($2::uuid[])`,
    [status, ids]
  );
};

module.exports = {
  findAll, findById, findByUnitCode, findByUnitCodeForClient,
  create, update, updateStatus, updateStatusBulk,
};
