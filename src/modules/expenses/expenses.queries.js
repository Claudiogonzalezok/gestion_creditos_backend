const pool = require('../../config/db');

const findAll = async ({ dateFrom, dateTo, categoryId, page = 1, limit = 20 } = {}) => {
  const offset = (page - 1) * limit;

  let base = `
    FROM expenses e
    JOIN users u ON u.id = e.created_by
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    WHERE 1=1`;
  const params = [];
  if (dateFrom)   { params.push(dateFrom);   base += ` AND e.expense_date >= $${params.length}`; }
  if (dateTo)     { params.push(dateTo);     base += ` AND e.expense_date <= $${params.length}`; }
  if (categoryId) { params.push(categoryId); base += ` AND e.category_id = $${params.length}`; }

  const selectFields = `
    SELECT e.id, e.amount::float8, e.description, e.expense_date,
           e.payment_method, e.transfer_reference, e.created_at,
           u.full_name AS created_by_name,
           ec.id AS category_id, ec.name AS category_name`;

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `${selectFields} ${base} ORDER BY e.expense_date DESC, e.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
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
    `SELECT e.id, e.amount::float8, e.description, e.expense_date,
            e.payment_method, e.transfer_reference, e.created_at,
            u.full_name AS created_by_name,
            ec.id AS category_id, ec.name AS category_name
     FROM expenses e
     JOIN users u ON u.id = e.created_by
     LEFT JOIN expense_categories ec ON ec.id = e.category_id
     WHERE e.id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

const findActiveCategoryById = async (id) => {
  const r = await pool.query(
    `SELECT id FROM expense_categories WHERE id = $1 AND active = TRUE`,
    [id]
  );
  return r.rows[0] || null;
};

/**
 * Busca un gasto idéntico registrado por el mismo usuario en los últimos 30 segundos.
 * Previene duplicados por doble envío o reintentos de red.
 * @param {{ amount: number, categoryId: string|null, expenseDate: string, createdBy: string }} params
 * @returns {Promise<object|null>}
 */
const findRecentDuplicate = async ({ amount, categoryId, expenseDate, createdBy }) => {
  const r = await pool.query(
    `SELECT id FROM expenses
     WHERE created_by  = $1
       AND amount      = $2
       AND expense_date = $3
       AND (category_id = $4 OR (category_id IS NULL AND $4 IS NULL))
       AND created_at  >= NOW() - INTERVAL '30 seconds'
     LIMIT 1`,
    [createdBy, amount, expenseDate, categoryId || null]
  );
  return r.rows[0] || null;
};

const create = async ({ amount, description, expenseDate, paymentMethod, transferReference, categoryId, createdBy, registerDate }) => {
  const r = await pool.query(
    `INSERT INTO expenses (amount, description, expense_date, payment_method, transfer_reference, category_id, created_by, register_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, amount::float8, description, expense_date, payment_method, transfer_reference, category_id, created_at`,
    [amount, description, expenseDate, paymentMethod, transferReference || null, categoryId || null, createdBy, registerDate]
  );
  return r.rows[0];
};

const update = async ({ id, amount, description, expenseDate, paymentMethod, transferReference, categoryId }) => {
  const r = await pool.query(
    `UPDATE expenses
     SET amount = $2,
         description = $3,
         expense_date = $4,
         payment_method = $5,
         transfer_reference = $6,
         category_id = $7
     WHERE id = $1
     RETURNING id, amount::float8, description, expense_date, payment_method, transfer_reference, category_id, created_at`,
    [id, amount, description, expenseDate, paymentMethod, transferReference || null, categoryId || null]
  );
  return r.rows[0] || null;
};

const remove = async (id) => {
  const r = await pool.query(
    `DELETE FROM expenses WHERE id = $1 RETURNING id`,
    [id]
  );
  return r.rowCount > 0;
};

module.exports = { findAll, findById, findActiveCategoryById, hasCashRegister, findRecentDuplicate, create, update, remove };
