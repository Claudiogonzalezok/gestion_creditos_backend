const pool = require('../../config/db');

const findAll = async ({ productId, status } = {}) => {
  let q = `
    SELECT pv.id, pv.color, pv.size, pv.capacity, pv.current_price::float8,
           pv.status, pv.created_at, pv.updated_at,
           p.id AS product_id, p.title AS product_name,
           p.description, p.model, p.status AS product_status,
           pb.id AS brand_id, pb.name AS brand_name
    FROM product_variants pv
    JOIN products p          ON p.id  = pv.product_id
    LEFT JOIN product_brands pb ON pb.id = p.brand_id
    WHERE 1=1`;
  const params = [];
  if (productId) { params.push(productId); q += ` AND pv.product_id = $${params.length}`; }
  if (status)    { params.push(status);    q += ` AND pv.status = $${params.length}`; }
  q += ` ORDER BY p.title ASC, pv.color ASC NULLS FIRST`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT pv.id, pv.color, pv.size, pv.capacity, pv.current_price::float8,
            pv.status, pv.created_at, pv.updated_at,
            p.id AS product_id, p.title AS product_name,
            p.description, p.model, p.status AS product_status,
            pb.id AS brand_id, pb.name AS brand_name,
            COALESCE(stock.available_count, 0) AS available_count,
            COALESCE(stock.reserved_count, 0)  AS reserved_count,
            COALESCE(stock.sold_count, 0)       AS sold_count
     FROM product_variants pv
     JOIN products p             ON p.id  = pv.product_id
     LEFT JOIN product_brands pb ON pb.id = p.brand_id
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) FILTER (WHERE status = 'AVAILABLE')::int AS available_count,
         COUNT(*) FILTER (WHERE status = 'RESERVED')::int  AS reserved_count,
         COUNT(*) FILTER (WHERE status = 'SOLD')::int      AS sold_count
       FROM product_units WHERE variant_id = pv.id
     ) stock ON TRUE
     WHERE pv.id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

const findByProductId = async (productId) => {
  const r = await pool.query(
    `SELECT pv.id, pv.color, pv.size, pv.capacity, pv.current_price::float8,
            pv.status, pv.created_at, pv.updated_at,
            COALESCE(stock.available_count, 0) AS available_count,
            COALESCE(stock.reserved_count, 0)  AS reserved_count,
            COALESCE(stock.sold_count, 0)       AS sold_count
     FROM product_variants pv
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) FILTER (WHERE status = 'AVAILABLE')::int AS available_count,
         COUNT(*) FILTER (WHERE status = 'RESERVED')::int  AS reserved_count,
         COUNT(*) FILTER (WHERE status = 'SOLD')::int      AS sold_count
       FROM product_units WHERE variant_id = pv.id
     ) stock ON TRUE
     WHERE pv.product_id = $1
     ORDER BY pv.color ASC NULLS FIRST`,
    [productId]
  );
  return r.rows;
};

const create = async ({ productId, color, size, capacity, currentPrice }) => {
  const r = await pool.query(
    `INSERT INTO product_variants (product_id, color, size, capacity, current_price)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, product_id, color, size, capacity, current_price::float8, status, created_at, updated_at`,
    [productId, color || null, size || null, capacity || null, currentPrice]
  );
  return r.rows[0];
};

const update = async (id, fields) => {
  const sets  = [];
  const params = [];

  if (fields.color    !== undefined) { params.push(fields.color    || null); sets.push(`color    = $${params.length}`); }
  if (fields.size     !== undefined) { params.push(fields.size     || null); sets.push(`size     = $${params.length}`); }
  if (fields.capacity !== undefined) { params.push(fields.capacity || null); sets.push(`capacity = $${params.length}`); }
  if (fields.currentPrice !== undefined) { params.push(fields.currentPrice); sets.push(`current_price = $${params.length}`); }

  if (!sets.length) return findById(id);

  sets.push('updated_at = NOW()');
  params.push(id);

  const r = await pool.query(
    `UPDATE product_variants SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, product_id, color, size, capacity, current_price::float8, status, updated_at`,
    params
  );
  return r.rows[0] || null;
};

const deactivate = async (id) => {
  await pool.query(
    `UPDATE product_variants SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1`, [id]
  );
};

const activate = async (id) => {
  await pool.query(
    `UPDATE product_variants SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1`, [id]
  );
};

const hasActiveUnits = async (id) => {
  const r = await pool.query(
    `SELECT id FROM product_units
     WHERE variant_id = $1 AND status IN ('AVAILABLE','RESERVED','SOLD') LIMIT 1`,
    [id]
  );
  return r.rows.length > 0;
};

const findActiveProductById = async (id) => {
  const r = await pool.query(
    `SELECT id, status FROM products WHERE id = $1`, [id]
  );
  return r.rows[0] || null;
};

// Busca variante con misma combinación de atributos para el mismo producto.
// excludeId permite ignorar la propia variante al actualizar.
const findDuplicate = async (productId, color, size, capacity, excludeId = null) => {
  const params = [productId, color || null, size || null, capacity || null];
  let q = `
    SELECT id FROM product_variants
    WHERE product_id = $1
      AND (color    IS NOT DISTINCT FROM $2)
      AND (size     IS NOT DISTINCT FROM $3)
      AND (capacity IS NOT DISTINCT FROM $4)`;
  if (excludeId) { params.push(excludeId); q += ` AND id <> $5`; }
  const r = await pool.query(q, params);
  return r.rows[0] || null;
};

module.exports = {
  findAll, findById, findByProductId,
  create, update, deactivate, activate,
  hasActiveUnits, findActiveProductById, findDuplicate,
};
