const pool = require('../../config/db');

const COLS = `
    pr.id, pr.product_id, p.description AS product_name,
    pr.payment_frequency, pr.installments_count::int,
    pr.rate::float8, pr.active, pr.created_at, pr.updated_at`;

const findAll = async (productId) => {
  let q = `
    SELECT ${COLS}
    FROM product_rates pr
    JOIN products p ON p.id = pr.product_id
    WHERE 1=1`;
  const params = [];
  if (productId) {
    params.push(productId);
    q += ` AND pr.product_id = $${params.length}`;
  }
  q += ` ORDER BY p.description, pr.payment_frequency, pr.installments_count`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT ${COLS}
     FROM product_rates pr
     JOIN products p ON p.id = pr.product_id
     WHERE pr.id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

/**
 * Busca coincidencia exacta interna (sin JOIN) para detectar duplicados.
 */
const findExact = async (productId, paymentFrequency, installmentsCount) => {
  const r = await pool.query(
    `SELECT id, active FROM product_rates
     WHERE product_id = $1 AND payment_frequency = $2 AND installments_count = $3`,
    [productId, paymentFrequency, installmentsCount]
  );
  return r.rows[0] || null;
};

/**
 * Busca la tasa activa para (producto, frecuencia, cuotas).
 * Acepta un cliente de transacción opcional.
 */
const findActiveRate = async (productId, paymentFrequency, installmentsCount, client = null) => {
  const executor = client || pool;
  const r = await executor.query(
    `SELECT id, rate FROM product_rates
     WHERE product_id = $1
       AND payment_frequency = $2
       AND installments_count = $3
       AND active = TRUE`,
    [productId, paymentFrequency, installmentsCount]
  );
  return r.rows[0] || null;
};

const create = async ({ product_id, payment_frequency, installments_count, rate }) => {
  const existing = await findExact(product_id, payment_frequency, installments_count);
  if (existing) {
    if (existing.active)
      throw { status: 409, message: 'Ya existe una tasa activa para esta combinación de producto, frecuencia y cuotas.' };
    // Reactiva la entrada desactivada con la nueva tasa
    const r = await pool.query(
      `UPDATE product_rates
       SET rate = $1, active = TRUE, updated_at = NOW()
       WHERE id = $2
       RETURNING id`,
      [rate, existing.id]
    );
    return findById(r.rows[0].id);
  }
  const r = await pool.query(
    `INSERT INTO product_rates (product_id, payment_frequency, installments_count, rate)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [product_id, payment_frequency, installments_count, rate]
  );
  return findById(r.rows[0].id);
};

const update = async (id, fields) => {
  const sets = [];
  const params = [];
  if (fields.rate !== undefined)   { params.push(fields.rate);   sets.push(`rate = $${params.length}`); }
  if (fields.active !== undefined) { params.push(fields.active); sets.push(`active = $${params.length}`); }
  if (!sets.length) return findById(id);
  sets.push('updated_at = NOW()');
  params.push(id);
  await pool.query(
    `UPDATE product_rates SET ${sets.join(', ')} WHERE id = $${params.length}`,
    params
  );
  return findById(id);
};

module.exports = { findAll, findById, findExact, findActiveRate, create, update };
