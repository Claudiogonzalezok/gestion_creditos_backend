const pool = require('../../config/db');

const findAll = async ({ dateFrom, dateTo } = {}) => {
  let q = `
    SELECT e.id, e.amount::float8, e.description, e.payment_method,
           e.transfer_reference, e.created_at,
           u.full_name AS created_by_name
    FROM expenses e
    JOIN users u ON u.id = e.created_by
    WHERE 1=1`;
  const params = [];
  if (dateFrom) { params.push(dateFrom); q += ` AND e.created_at::date >= $${params.length}`; }
  if (dateTo)   { params.push(dateTo);   q += ` AND e.created_at::date <= $${params.length}`; }
  q += ` ORDER BY e.created_at DESC`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT e.id, e.amount::float8, e.description, e.payment_method,
            e.transfer_reference, e.created_at,
            u.full_name AS created_by_name
     FROM expenses e
     JOIN users u ON u.id = e.created_by
     WHERE e.id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

const create = async ({ amount, description, paymentMethod, transferReference, createdBy }) => {
  const r = await pool.query(
    `INSERT INTO expenses (amount, description, payment_method, transfer_reference, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, amount::float8, description, payment_method, transfer_reference, created_at`,
    [amount, description, paymentMethod, transferReference || null, createdBy]
  );
  return r.rows[0];
};

const remove = async (id) => {
  const r = await pool.query(
    `DELETE FROM expenses WHERE id = $1 RETURNING id`,
    [id]
  );
  return r.rowCount > 0;
};

module.exports = { findAll, findById, create, remove };
