const pool = require('../../config/db');

/**
 * Lista categorías con la cantidad de productos activos asociados para la tabla de configuración.
 * @param {{ includeInactive?: boolean }} options - Filtros de listado.
 */
const findAll = async ({ includeInactive = false } = {}) => {
  let q = `
    SELECT
      pc.id,
      pc.name,
      pc.active,
      pc.created_at,
      COUNT(p.id)::int AS product_count
    FROM product_categories pc
    LEFT JOIN products p
      ON p.category_id = pc.id
     AND p.status = 'ACTIVE'
  `;
  if (!includeInactive) q += ` WHERE pc.active = TRUE`;
  q += ` GROUP BY pc.id, pc.name, pc.active, pc.created_at ORDER BY pc.name ASC`;
  return (await pool.query(q)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT id, name, active, created_at FROM product_categories WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

const findByName = async (name) => {
  const r = await pool.query(
    `SELECT id FROM product_categories WHERE LOWER(name) = LOWER($1)`,
    [name]
  );
  return r.rows[0] || null;
};

const create = async ({ name }) => {
  const r = await pool.query(
    `INSERT INTO product_categories (name)
     VALUES ($1)
     RETURNING id, name, active, created_at`,
    [name]
  );
  return r.rows[0];
};

const update = async (id, name) => {
  const r = await pool.query(
    `UPDATE product_categories SET name = $1 WHERE id = $2
     RETURNING id, name, active, created_at`,
    [name, id]
  );
  return r.rows[0] || null;
};

const activate = async (id) => {
  await pool.query(
    `UPDATE product_categories SET active = TRUE WHERE id = $1`,
    [id]
  );
};

const deactivate = async (id) => {
  await pool.query(
    `UPDATE product_categories SET active = FALSE WHERE id = $1`,
    [id]
  );
};

const hasActiveProducts = async (id) => {
  const r = await pool.query(
    `SELECT id FROM products WHERE category_id = $1 AND status = 'ACTIVE' LIMIT 1`, [id]
  );
  return r.rows.length > 0;
};

module.exports = { findAll, findById, findByName, create, update, activate, deactivate, hasActiveProducts };
