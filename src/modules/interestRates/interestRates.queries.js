const pool = require('../../config/db');

const findAll = async ({ credit_type, payment_frequency, active } = {}) => {
  let q = `SELECT id, credit_type, payment_frequency, installments_count, rate, active, created_at, updated_at
           FROM interest_rates WHERE 1=1`;
  const params = [];
  if (credit_type)          { params.push(credit_type);       q += ` AND credit_type = $${params.length}`; }
  if (payment_frequency)    { params.push(payment_frequency); q += ` AND payment_frequency = $${params.length}`; }
  if (active !== undefined) { params.push(active);            q += ` AND active = $${params.length}`; }
  q += ` ORDER BY credit_type, payment_frequency, installments_count ASC`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT id, credit_type, payment_frequency, installments_count, rate, active, created_at, updated_at
     FROM interest_rates WHERE id = $1`, [id]
  );
  return r.rows[0] || null;
};

const findDuplicate = async (credit_type, payment_frequency, installments_count) => {
  const r = await pool.query(
    `SELECT id, active FROM interest_rates
     WHERE credit_type = $1 AND payment_frequency = $2 AND installments_count = $3`,
    [credit_type, payment_frequency, installments_count]
  );
  return r.rows[0] || null;
};

const findActiveRate = async (credit_type, payment_frequency, installments_count) => {
  const r = await pool.query(
    `SELECT id, rate FROM interest_rates
     WHERE credit_type = $1 AND payment_frequency = $2 AND installments_count = $3 AND active = TRUE`,
    [credit_type, payment_frequency, installments_count]
  );
  return r.rows[0] || null;
};

const create = async ({ credit_type, payment_frequency, installments_count, rate }) => {
  const r = await pool.query(
    `INSERT INTO interest_rates (credit_type, payment_frequency, installments_count, rate)
     VALUES ($1, $2, $3, $4)
     RETURNING id, credit_type, payment_frequency, installments_count, rate, active, created_at`,
    [credit_type, payment_frequency, installments_count, rate]
  );
  return r.rows[0];
};

const update = async (id, { rate, active }) => {
  const r = await pool.query(
    `UPDATE interest_rates
     SET rate = COALESCE($1, rate), active = COALESCE($2, active), updated_at = NOW()
     WHERE id = $3
     RETURNING id, credit_type, payment_frequency, installments_count, rate, active, updated_at`,
    [rate ?? null, active ?? null, id]
  );
  return r.rows[0] || null;
};

const reactivate = async (id, rate) => {
  const r = await pool.query(
    `UPDATE interest_rates
     SET active = TRUE, rate = COALESCE($1, rate), updated_at = NOW()
     WHERE id = $2
     RETURNING id, credit_type, payment_frequency, installments_count, rate, active`,
    [rate ?? null, id]
  );
  return r.rows[0];
};

const deactivate = async (id) =>
  pool.query(`UPDATE interest_rates SET active = FALSE, updated_at = NOW() WHERE id = $1`, [id]);

const activate = async (id) =>
  pool.query(`UPDATE interest_rates SET active = TRUE, updated_at = NOW() WHERE id = $1`, [id]);

module.exports = { findAll, findById, findDuplicate, findActiveRate, create, update, reactivate, deactivate, activate };
