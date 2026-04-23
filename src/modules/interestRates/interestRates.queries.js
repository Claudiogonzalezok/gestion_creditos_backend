const pool = require('../../config/db');

const COLS = `id, payment_frequency, installments_count::int,
              min_amount::float8, max_amount::float8, rate::float8, active, created_at, updated_at`;

const findAll = async ({ payment_frequency, active } = {}) => {
  let q = `SELECT ${COLS} FROM interest_rates WHERE 1=1`;
  const params = [];
  if (payment_frequency)    { params.push(payment_frequency); q += ` AND payment_frequency = $${params.length}`; }
  if (active !== undefined) { params.push(active);            q += ` AND active = $${params.length}`; }
  q += ` ORDER BY payment_frequency, installments_count, min_amount ASC`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT ${COLS} FROM interest_rates WHERE id = $1`, [id]
  );
  return r.rows[0] || null;
};

/**
 * Busca coincidencia exacta de los 4 campos que forman la clave única de negocio.
 */
const findExact = async (payment_frequency, installments_count, min_amount, max_amount) => {
  const r = await pool.query(
    `SELECT id, active FROM interest_rates
     WHERE payment_frequency = $1
       AND installments_count = $2
       AND min_amount = $3
       AND (max_amount = $4 OR (max_amount IS NULL AND $4::numeric IS NULL))`,
    [payment_frequency, installments_count, min_amount, max_amount ?? null]
  );
  return r.rows[0] || null;
};

/**
 * Detecta solapamiento de rangos de monto para la misma combinación
 * (payment_frequency, installments_count).
 * Excluye opcionalmente un ID (útil al actualizar).
 */
const findOverlap = async (payment_frequency, installments_count, min_amount, max_amount, excludeId = null) => {
  const params = [payment_frequency, installments_count, min_amount, max_amount ?? null];
  let q = `
    SELECT id FROM interest_rates
    WHERE payment_frequency = $1
      AND installments_count = $2
      AND active = TRUE
      AND min_amount <= COALESCE($4::numeric, 'Infinity')
      AND COALESCE(max_amount, 'Infinity'::numeric) >= $3
  `;
  if (excludeId) {
    params.push(excludeId);
    q += ` AND id != $${params.length}`;
  }
  const r = await pool.query(q, params);
  return r.rows[0] || null;
};

/**
 * Busca la tasa activa que corresponde al monto solicitado.
 * Se aplica a cualquier tipo de crédito (SALE o LOAN).
 */
const findActiveRate = async (payment_frequency, installments_count, amount) => {
  const r = await pool.query(
    `SELECT id, rate FROM interest_rates
     WHERE payment_frequency = $1
       AND installments_count = $2
       AND active = TRUE
       AND $3 >= min_amount
       AND ($3 <= max_amount OR max_amount IS NULL)`,
    [payment_frequency, installments_count, amount]
  );
  return r.rows[0] || null;
};

const create = async ({ payment_frequency, installments_count, min_amount, max_amount, rate }) => {
  const r = await pool.query(
    `INSERT INTO interest_rates
       (payment_frequency, installments_count, min_amount, max_amount, rate)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLS}`,
    [payment_frequency, installments_count, min_amount, max_amount ?? null, rate]
  );
  return r.rows[0];
};

const update = async (id, { rate, active }) => {
  const r = await pool.query(
    `UPDATE interest_rates
     SET rate = COALESCE($1, rate), active = COALESCE($2, active), updated_at = NOW()
     WHERE id = $3
     RETURNING ${COLS}`,
    [rate ?? null, active ?? null, id]
  );
  return r.rows[0] || null;
};

const reactivate = async (id, rate) => {
  const r = await pool.query(
    `UPDATE interest_rates
     SET active = TRUE, rate = COALESCE($1, rate), updated_at = NOW()
     WHERE id = $2
     RETURNING ${COLS}`,
    [rate ?? null, id]
  );
  return r.rows[0];
};

const deactivate = async (id) =>
  pool.query(`UPDATE interest_rates SET active = FALSE, updated_at = NOW() WHERE id = $1`, [id]);

const activate = async (id) =>
  pool.query(`UPDATE interest_rates SET active = TRUE, updated_at = NOW() WHERE id = $1`, [id]);

module.exports = {
  findAll, findById, findExact, findOverlap, findActiveRate,
  create, update, reactivate, deactivate, activate,
};
