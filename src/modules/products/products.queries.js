const pool = require('../../config/db');

// available_count = unidades con status AVAILABLE para ese producto
const findAll = async ({ status, search, categoryId } = {}) => {
  let q = `
    SELECT p.id, p.description, p.current_price::float8,
           p.status, p.created_at,
           pc.id AS category_id, pc.name AS category_name,
           COUNT(pu.id) FILTER (WHERE pu.status = 'AVAILABLE')::int AS available_count,
           COUNT(pu.id) FILTER (WHERE pu.status = 'RESERVED')::int AS reserved_count,
           COUNT(pu.id) FILTER (WHERE pu.status = 'SOLD')::int     AS sold_count
    FROM products p
    LEFT JOIN product_categories pc ON pc.id = p.category_id
    LEFT JOIN product_units pu      ON pu.product_id = p.id
    WHERE 1=1`;
  const params = [];

  if (status)     { params.push(status);       q += ` AND p.status = $${params.length}`; }
  if (search)     { params.push(`%${search}%`); q += ` AND p.description ILIKE $${params.length}`; }
  if (categoryId) { params.push(categoryId);   q += ` AND p.category_id = $${params.length}`; }
  q += ` GROUP BY p.id, pc.id ORDER BY p.description ASC`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const result = await pool.query(
    `SELECT p.id, p.description, p.current_price::float8,
            p.status, p.created_at, p.updated_at,
            pc.id AS category_id, pc.name AS category_name,
            COUNT(pu.id) FILTER (WHERE pu.status = 'AVAILABLE')::int AS available_count,
            COUNT(pu.id) FILTER (WHERE pu.status = 'RESERVED')::int  AS reserved_count,
            COUNT(pu.id) FILTER (WHERE pu.status = 'SOLD')::int      AS sold_count
     FROM products p
     LEFT JOIN product_categories pc ON pc.id = p.category_id
     LEFT JOIN product_units pu      ON pu.product_id = p.id
     WHERE p.id = $1
     GROUP BY p.id, pc.id`,
    [id]
  );
  return result.rows[0] || null;
};

const findActiveCategoryById = async (id) => {
  const r = await pool.query(
    `SELECT id FROM product_categories WHERE id = $1 AND active = TRUE`, [id]
  );
  return r.rows[0] || null;
};

const findByDescription = async (description) => {
  const result = await pool.query(
    `SELECT id FROM products WHERE LOWER(description) = LOWER($1)`, [description]
  );
  return result.rows[0] || null;
};

// Un producto tiene créditos activos si alguna de sus unidades está SOLD o RESERVED
const hasActiveCredits = async (id) => {
  const result = await pool.query(
    `SELECT id FROM product_units
     WHERE product_id = $1 AND status IN ('RESERVED','SOLD')
     LIMIT 1`,
    [id]
  );
  return result.rows.length > 0;
};

const create = async ({ description, current_price, category_id }) => {
  const result = await pool.query(
    `INSERT INTO products (description, current_price, category_id)
     VALUES ($1, $2, $3)
     RETURNING id, description, current_price::float8, category_id, status, created_at`,
    [description, current_price, category_id || null]
  );
  return { ...result.rows[0], available_count: 0, reserved_count: 0, sold_count: 0 };
};

const update = async (id, { description, current_price, category_id }) => {
  const result = await pool.query(
    `UPDATE products
     SET description   = COALESCE($1, description),
         current_price = COALESCE($2, current_price),
         category_id   = COALESCE($3, category_id),
         updated_at    = NOW()
     WHERE id = $4
     RETURNING id, description, current_price::float8, category_id, status, updated_at`,
    [description, current_price, category_id, id]
  );
  return result.rows[0] || null;
};

const deactivate = async (id) => {
  await pool.query(
    `UPDATE products SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1`, [id]
  );
};

const activate = async (id) => {
  await pool.query(
    `UPDATE products SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1`, [id]
  );
};

module.exports = {
  findAll, findById, findByDescription, findActiveCategoryById, hasActiveCredits,
  create, update, deactivate, activate,
};
