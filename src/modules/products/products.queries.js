const pool = require('../../config/db');

const findAll = async ({ status, search } = {}) => {
  let q = `
    SELECT id, name, description, current_price, available_stock, status, created_at
    FROM products
    WHERE 1=1`;
  const params = [];

  if (status) {
    params.push(status);
    q += ` AND status = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    q += ` AND name ILIKE $${params.length}`;
  }
  q += ` ORDER BY name ASC`;
  const result = await pool.query(q, params);
  return result.rows;
};

const findById = async (id) => {
  const result = await pool.query(
    `SELECT id, name, description, current_price, available_stock, status, created_at, updated_at
     FROM products WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
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

const create = async ({ name, description, current_price, available_stock }) => {
  const result = await pool.query(
    `INSERT INTO products (name, description, current_price, available_stock)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, description, current_price, available_stock, status, created_at`,
    [name, description || null, current_price, available_stock ?? 0]
  );
  return result.rows[0];
};

const update = async (id, { name, description, current_price }) => {
  const result = await pool.query(
    `UPDATE products
     SET name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         current_price = COALESCE($3, current_price),
         updated_at    = NOW()
     WHERE id = $4
     RETURNING id, name, description, current_price, available_stock, status, updated_at`,
    [name, description, current_price, id]
  );
  return result.rows[0] || null;
};

const adjustStock = async (id, quantity, movement) => {
  const operator = movement === 'IN' ? '+' : '-';
  const result = await pool.query(
    `UPDATE products
     SET available_stock = available_stock ${operator} $1,
         updated_at      = NOW()
     WHERE id = $2
     RETURNING id, name, available_stock`,
    [quantity, id]
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
  findAll, findById, findByName, hasActiveCredits,
  create, update, adjustStock, deactivate, activate,
};
