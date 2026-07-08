const pool = require("../../config/db");
const cache = require("../../utils/cache");

const CACHE_PREFIX = "interest_rates:";
const CACHE_TTL = require("../../utils/cache").TTL.LONG;

const COLS = `id, payment_frequency, installments_count::int,
              min_amount::float8, max_amount::float8, rate::float8, active, created_at, updated_at`;

const findAll = async ({ payment_frequency, active } = {}) => {
  const cacheKey = `${CACHE_PREFIX}all:${JSON.stringify({ payment_frequency: payment_frequency ?? null, active: active ?? null })}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  let q = `SELECT ${COLS} FROM interest_rates WHERE 1=1`;
  const params = [];
  if (payment_frequency) {
    params.push(payment_frequency);
    q += ` AND payment_frequency = $${params.length}`;
  }
  if (active !== undefined) {
    params.push(active);
    q += ` AND active = $${params.length}`;
  }
  q += ` ORDER BY payment_frequency, installments_count, min_amount ASC`;
  const rows = (await pool.query(q, params)).rows;
  cache.set(cacheKey, rows, CACHE_TTL);
  return rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT ${COLS} FROM interest_rates WHERE id = $1`,
    [id],
  );
  return r.rows[0] || null;
};

/**
 * Busca coincidencia exacta de los 4 campos que forman la clave única de negocio.
 */
const findExact = async (
  payment_frequency,
  installments_count,
  min_amount,
  max_amount,
) => {
  const r = await pool.query(
    `SELECT id, active FROM interest_rates
     WHERE payment_frequency = $1
       AND installments_count = $2
       AND min_amount = $3
       AND (max_amount = $4 OR (max_amount IS NULL AND $4::numeric IS NULL))`,
    [payment_frequency, installments_count, min_amount, max_amount ?? null],
  );
  return r.rows[0] || null;
};

/**
 * Detecta solapamiento de rangos de monto para la misma combinación
 * (payment_frequency, installments_count).
 * Excluye opcionalmente un ID (útil al actualizar).
 */
const findOverlap = async (
  payment_frequency,
  installments_count,
  min_amount,
  max_amount,
  excludeId = null,
) => {
  const params = [
    payment_frequency,
    installments_count,
    min_amount,
    max_amount ?? null,
  ];
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
const findActiveRate = async (
  payment_frequency,
  installments_count,
  amount,
) => {
  const r = await pool.query(
    `SELECT id, rate FROM interest_rates
     WHERE payment_frequency = $1
       AND installments_count = $2
       AND active = TRUE
       AND $3 >= min_amount
       AND ($3 <= max_amount OR max_amount IS NULL)`,
    [payment_frequency, installments_count, amount],
  );
  return r.rows[0] || null;
};

/**
 * Devuelve los valores únicos de installments_count activos, agrupados por payment_frequency.
 * Usado por el endpoint público del simulador.
 */
const findActiveInstallmentOptions = async () => {
  const cacheKey = `${CACHE_PREFIX}active_options`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const r = await pool.query(
    `SELECT DISTINCT payment_frequency, installments_count::int
     FROM interest_rates
     WHERE active = TRUE
     ORDER BY payment_frequency, installments_count ASC`,
  );
  const result = {};
  for (const row of r.rows) {
    if (!result[row.payment_frequency]) result[row.payment_frequency] = [];
    result[row.payment_frequency].push(row.installments_count);
  }
  cache.set(cacheKey, result, CACHE_TTL);
  return result;
};

const create = async ({
  payment_frequency,
  installments_count,
  min_amount,
  max_amount,
  rate,
}) => {
  const r = await pool.query(
    `INSERT INTO interest_rates
       (payment_frequency, installments_count, min_amount, max_amount, rate)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLS}`,
    [
      payment_frequency,
      installments_count,
      min_amount,
      max_amount ?? null,
      rate,
    ],
  );
  cache.invalidateByPrefix(CACHE_PREFIX);
  return r.rows[0];
};

const update = async (id, { rate, active }) => {
  const r = await pool.query(
    `UPDATE interest_rates
     SET rate = COALESCE($1, rate), active = COALESCE($2, active), updated_at = NOW()
     WHERE id = $3
     RETURNING ${COLS}`,
    [rate ?? null, active ?? null, id],
  );
  cache.invalidateByPrefix(CACHE_PREFIX);
  return r.rows[0] || null;
};

const reactivate = async (id, rate) => {
  const r = await pool.query(
    `UPDATE interest_rates
     SET active = TRUE, rate = COALESCE($1, rate), updated_at = NOW()
     WHERE id = $2
     RETURNING ${COLS}`,
    [rate ?? null, id],
  );
  cache.invalidateByPrefix(CACHE_PREFIX);
  return r.rows[0];
};

const deactivate = async (id) => {
  const r = await pool.query(
    `UPDATE interest_rates SET active = FALSE, updated_at = NOW() WHERE id = $1`,
    [id],
  );
  cache.invalidateByPrefix(CACHE_PREFIX);
  return r;
};

const activate = async (id) => {
  const r = await pool.query(
    `UPDATE interest_rates SET active = TRUE, updated_at = NOW() WHERE id = $1`,
    [id],
  );
  cache.invalidateByPrefix(CACHE_PREFIX);
  return r;
};

module.exports = {
  findAll,
  findById,
  findExact,
  findOverlap,
  findActiveRate,
  findActiveInstallmentOptions,
  create,
  update,
  reactivate,
  deactivate,
  activate,
};
