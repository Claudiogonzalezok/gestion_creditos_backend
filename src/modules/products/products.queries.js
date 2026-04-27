const pool = require('../../config/db');

const findAll = async ({ status, search, categoryId } = {}) => {
  let q = `
    SELECT p.id, p.name, p.description, p.current_price::float8,
           p.available_stock::int, p.status, p.created_at,
           pc.id AS category_id, pc.name AS category_name
    FROM products p
    LEFT JOIN product_categories pc ON pc.id = p.category_id
    WHERE 1=1`;
  const params = [];

  if (status) {
    params.push(status);
    q += ` AND p.status = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    q += ` AND p.name ILIKE $${params.length}`;
  }
  if (categoryId) {
    params.push(categoryId);
    q += ` AND p.category_id = $${params.length}`;
  }
  q += ` ORDER BY p.name ASC`;
  const result = await pool.query(q, params);
  return result.rows;
};

const findById = async (id) => {
  const result = await pool.query(
    `SELECT p.id, p.name, p.description, p.current_price::float8,
            p.available_stock::int, p.status, p.created_at, p.updated_at,
            pc.id AS category_id, pc.name AS category_name
     FROM products p
     LEFT JOIN product_categories pc ON pc.id = p.category_id
     WHERE p.id = $1`,
    [id]
  );
  return result.rows[0] || null;
};

const findActiveCategoryById = async (id) => {
  const r = await pool.query(
    `SELECT id FROM product_categories WHERE id = $1 AND active = TRUE`,
    [id]
  );
  return r.rows[0] || null;
};

const findByName = async (name) => {
  const result = await pool.query(
    `SELECT id FROM products WHERE LOWER(name) = LOWER($1)`, [name]
  );
  return result.rows[0] || null;
};

const hasActiveCredits = async (id) => {
  const result = await pool.query(
    `SELECT cp.id FROM credit_products cp
     JOIN credits c ON c.id = cp.credit_id
     WHERE cp.product_id = $1 AND c.status = 'ACTIVE'
     LIMIT 1`,
    [id]
  );
  return result.rows.length > 0;
};

const create = async ({ name, description, current_price, available_stock, category_id }) => {
  const result = await pool.query(
    `INSERT INTO products (name, description, current_price, available_stock, category_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, description, current_price::float8, available_stock::int, category_id, status, created_at`,
    [name, description || null, current_price, available_stock ?? 0, category_id || null]
  );
  return result.rows[0];
};

const update = async (id, { name, description, current_price, category_id }) => {
  const result = await pool.query(
    `UPDATE products
     SET name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         current_price = COALESCE($3, current_price),
         category_id   = COALESCE($4, category_id),
         updated_at    = NOW()
     WHERE id = $5
     RETURNING id, name, description, current_price::float8, available_stock::int, category_id, status, updated_at`,
    [name, description, current_price, category_id, id]
  );
  return result.rows[0] || null;
};

/**
 * Ajusta el stock del producto y registra el movimiento en stock_movements (CU04).
 * Requiere tabla:
 *   CREATE TABLE stock_movements (
 *     id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     product_id           UUID NOT NULL REFERENCES products(id),
 *     movement             VARCHAR(3) NOT NULL CHECK (movement IN ('IN','OUT')),
 *     quantity             INTEGER NOT NULL,
 *     reason               VARCHAR(255),
 *     available_stock_after INTEGER NOT NULL,
 *     user_id              UUID REFERENCES users(id),
 *     created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 */
const adjustStock = async (id, quantity, movement, reason, userId) => {
  const operator = movement === 'IN' ? '+' : '-';

  // Actualizar stock y obtener el nuevo valor en una sola consulta
  const updated = await pool.query(
    `UPDATE products
     SET available_stock = available_stock ${operator} $1,
         updated_at      = NOW()
     WHERE id = $2
     RETURNING id, name, available_stock::int`,
    [quantity, id]
  );

  const product = updated.rows[0];

  await pool.query(
    `INSERT INTO stock_movements
       (product_id, movement, quantity, reason, available_stock_after, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, movement, quantity, reason || null, product.available_stock, userId || null]
  );

  return product;
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
  findAll, findById, findByName, findActiveCategoryById, hasActiveCredits,
  create, update, adjustStock, deactivate, activate,
};
