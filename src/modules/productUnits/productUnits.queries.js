const pool = require('../../config/db');

const findAll = async ({ productId, status, search } = {}) => {
  let q = `
    SELECT pu.id, pu.unit_code, pu.status, pu.notes, pu.created_at, pu.updated_at,
           p.id AS product_id, p.description AS product_name, p.current_price::float8
    FROM product_units pu
    JOIN products p ON p.id = pu.product_id
    WHERE 1=1`;
  const params = [];
  if (productId) { params.push(productId); q += ` AND pu.product_id = $${params.length}`; }
  if (status)    { params.push(status);    q += ` AND pu.status = $${params.length}`; }
  if (search)    { params.push(`%${search}%`); q += ` AND pu.unit_code ILIKE $${params.length}`; }
  q += ` ORDER BY p.description ASC, pu.unit_code ASC`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT pu.id, pu.unit_code, pu.status, pu.notes, pu.created_at, pu.updated_at,
            p.id AS product_id, p.description AS product_name, p.current_price::float8
     FROM product_units pu
     JOIN products p ON p.id = pu.product_id
     WHERE pu.id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

const findByUnitCode = async (unitCode) => {
  const r = await pool.query(
    `SELECT id FROM product_units WHERE unit_code = $1`, [unitCode]
  );
  return r.rows[0] || null;
};

const findByUnitCodeForClient = async (client, unitCode) => {
  const r = await client.query(
    `SELECT id FROM product_units WHERE unit_code = $1`, [unitCode]
  );
  return r.rows[0] || null;
};

// Crea una unidad individual y registra el movimiento IN
const create = async (client, { productId, unitCode, notes, userId }) => {
  const r = await client.query(
    `INSERT INTO product_units (product_id, unit_code, notes)
     VALUES ($1, $2, $3)
     RETURNING id, unit_code, status, notes, created_at`,
    [productId, unitCode, notes || null]
  );
  const unit = r.rows[0];
  await client.query(
    `INSERT INTO stock_movements (product_id, product_unit_id, movement, quantity, reason, user_id)
     VALUES ($1, $2, 'IN', 1, 'Alta de unidad', $3)`,
    [productId, unit.id, userId || null]
  );
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

// Cambia el status de una unidad (para INACTIVE desde el servicio)
const updateStatus = async (client, id, status) => {
  await client.query(
    `UPDATE product_units SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, id]
  );
};

// Actualiza status por lote (array de IDs)
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
