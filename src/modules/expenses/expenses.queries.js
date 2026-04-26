const pool = require('../../config/db');

const findAll = async ({ dateFrom, dateTo, page = 1, limit = 20 } = {}) => {
  const offset = (page - 1) * limit;

  let base = `
    FROM expenses e
    JOIN users u ON u.id = e.created_by
    WHERE 1=1`;
  const params = [];
  if (dateFrom) { params.push(dateFrom); base += ` AND e.created_at::date >= $${params.length}`; }
  if (dateTo)   { params.push(dateTo);   base += ` AND e.created_at::date <= $${params.length}`; }

  const selectFields = `
    SELECT e.id, e.amount::float8, e.description, e.payment_method,
           e.transfer_reference, e.created_at,
           u.full_name AS created_by_name`;

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `${selectFields} ${base} ORDER BY e.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total ${base}`, params),
  ]);

  return { rows: dataResult.rows, total: countResult.rows[0].total };
};

const hasCashRegister = async (date) => {
  const r = await pool.query(
    `SELECT id FROM cash_registers WHERE register_date = $1::date`,
    [date]
  );
  return r.rows.length > 0;
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

module.exports = { findAll, findById, hasCashRegister, create, remove };
