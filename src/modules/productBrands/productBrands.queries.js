const pool = require('../../config/db');

/**
 * Lista marcas con la cantidad de productos activos asociados para la tabla de configuración.
 * @param {boolean} includeInactive - Indica si debe incluir marcas inactivas.
 */
const findAll = async (includeInactive = false) => {
  let q = `
    SELECT
      pb.id,
      pb.name,
      pb.active,
      pb.created_at,
      COUNT(p.id)::int AS product_count
    FROM product_brands pb
    LEFT JOIN products p
      ON p.brand_id = pb.id
     AND p.status = 'ACTIVE'
  `;
  if (!includeInactive) q += ` WHERE pb.active = TRUE`;
  q += ` GROUP BY pb.id, pb.name, pb.active, pb.created_at ORDER BY pb.name ASC`;
  return (await pool.query(q)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT id, name, active, created_at FROM product_brands WHERE id = $1`, [id]
  );
  return r.rows[0] || null;
};

const findByName = async (name) => {
  const r = await pool.query(
    `SELECT id FROM product_brands WHERE LOWER(name) = LOWER($1)`, [name]
  );
  return r.rows[0] || null;
};

const create = async (name) => {
  const r = await pool.query(
    `INSERT INTO product_brands (name) VALUES ($1)
     RETURNING id, name, active, created_at`,
    [name]
  );
  return r.rows[0];
};

const update = async (id, name) => {
  const r = await pool.query(
    `UPDATE product_brands SET name = $1 WHERE id = $2
     RETURNING id, name, active, created_at`,
    [name, id]
  );
  return r.rows[0] || null;
};

const deactivate = async (id) => {
  await pool.query(
    `UPDATE product_brands SET active = FALSE WHERE id = $1`, [id]
  );
};

const activate = async (id) => {
  await pool.query(
    `UPDATE product_brands SET active = TRUE WHERE id = $1`, [id]
  );
};

const hasActiveProducts = async (id) => {
  const r = await pool.query(
    `SELECT id FROM products WHERE brand_id = $1 AND status = 'ACTIVE' LIMIT 1`, [id]
  );
  return r.rows.length > 0;
};

module.exports = { findAll, findById, findByName, create, update, deactivate, activate, hasActiveProducts };
