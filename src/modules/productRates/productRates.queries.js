const pool = require("../../config/db");
const cache = require("../../utils/cache");

const CACHE_PREFIX = "product_rates:";
const CACHE_TTL = require("../../utils/cache").TTL.LONG;

const COLS = `
    pr.id, pr.product_id, p.title AS product_name,
    pr.payment_frequency, pr.installments_count::int,
    pr.rate::float8, pr.active, pr.created_at, pr.updated_at`;

const findAll = async (productId) => {
  const cacheKey = `${CACHE_PREFIX}all:${productId || "all"}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

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
  q += ` ORDER BY p.title, pr.payment_frequency, pr.installments_count`;
  const rows = (await pool.query(q, params)).rows;
  cache.set(cacheKey, rows, CACHE_TTL);
  return rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT ${COLS}
     FROM product_rates pr
     JOIN products p ON p.id = pr.product_id
     WHERE pr.id = $1`,
    [id],
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
    [productId, paymentFrequency, installmentsCount],
  );
  return r.rows[0] || null;
};

/**
 * Busca la tasa activa para (producto, frecuencia, cuotas).
 * Acepta un cliente de transacción opcional.
 */
const findActiveRate = async (
  productId,
  paymentFrequency,
  installmentsCount,
  client = null,
) => {
  const executor = client || pool;
  const r = await executor.query(
    `SELECT id, rate FROM product_rates
     WHERE product_id = $1
       AND payment_frequency = $2
       AND installments_count = $3
       AND active = TRUE`,
    [productId, paymentFrequency, installmentsCount],
  );
  return r.rows[0] || null;
};

const create = async ({
  product_id,
  payment_frequency,
  installments_count,
  rate,
}) => {
  const existing = await findExact(
    product_id,
    payment_frequency,
    installments_count,
  );
  if (existing) {
    if (existing.active)
      throw {
        status: 409,
        message:
          "Ya existe una tasa activa para esta combinación de producto, frecuencia y cuotas.",
      };
    // Reactiva la entrada desactivada con la nueva tasa
    const r = await pool.query(
      `UPDATE product_rates
       SET rate = $1, active = TRUE, updated_at = NOW()
       WHERE id = $2
       RETURNING id`,
      [rate, existing.id],
    );
    cache.invalidateByPrefix(CACHE_PREFIX);
    return findById(r.rows[0].id);
  }
  const r = await pool.query(
    `INSERT INTO product_rates (product_id, payment_frequency, installments_count, rate)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [product_id, payment_frequency, installments_count, rate],
  );
  cache.invalidateByPrefix(CACHE_PREFIX);
  return findById(r.rows[0].id);
};

const update = async (id, fields) => {
  const sets = [];
  const params = [];
  if (fields.rate !== undefined) {
    params.push(fields.rate);
    sets.push(`rate = $${params.length}`);
  }
  if (fields.active !== undefined) {
    params.push(fields.active);
    sets.push(`active = $${params.length}`);
  }
  if (!sets.length) return findById(id);
  sets.push("updated_at = NOW()");
  params.push(id);
  await pool.query(
    `UPDATE product_rates SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params,
  );
  cache.invalidateByPrefix(CACHE_PREFIX);
  return findById(id);
};

/**
 * Devuelve las combinaciones activas de (frecuencia → [cuotas]) para un producto dado.
 * Mismo formato que findActiveInstallmentOptions de interestRates.
 */
const findActiveInstallmentOptionsForProduct = async (productId) => {
  const cacheKey = `${CACHE_PREFIX}options:${productId}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const r = await pool.query(
    `SELECT DISTINCT payment_frequency, installments_count::int
     FROM product_rates
     WHERE product_id = $1 AND active = TRUE
     ORDER BY payment_frequency, installments_count ASC`,
    [productId],
  );
  const result = {};
  for (const row of r.rows) {
    if (!result[row.payment_frequency]) result[row.payment_frequency] = [];
    result[row.payment_frequency].push(row.installments_count);
  }
  cache.set(cacheKey, result, CACHE_TTL);
  return result;
};

/**
 * Devuelve productos activos con al menos una tasa de venta configurada,
 * junto con sus variantes activas. Soporta búsqueda por nombre y límite de resultados.
 * @param {object}  opts
 * @param {string}  [opts.search=''] - Texto a buscar en el título (ILIKE).
 * @param {number}  [opts.limit=10]  - Máximo de productos a devolver (tope 50).
 */
const findProductsWithActiveRates = async ({
  search = "",
  limit = 10,
} = {}) => {
  const params = [];
  const conditions = [
    `p.status = 'ACTIVE'`,
    `EXISTS (SELECT 1 FROM product_rates pr WHERE pr.product_id = p.id AND pr.active = TRUE)`,
  ];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`p.title ILIKE $${params.length}`);
  }

  params.push(Math.min(Math.max(parseInt(limit) || 10, 1), 50));
  const limitIdx = params.length;

  const r = await pool.query(
    `
    SELECT p.id, p.title,
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'id',            pv.id,
            'color',         pv.color,
            'size',          pv.size,
            'capacity',      pv.capacity,
            'current_price', pv.current_price::float8
          )
        ) FILTER (WHERE pv.status = 'ACTIVE'),
        '[]'::json
      ) AS variants
    FROM products p
    JOIN product_variants pv ON pv.product_id = p.id
    WHERE ${conditions.join(" AND ")}
    GROUP BY p.id, p.title
    ORDER BY p.title
    LIMIT $${limitIdx}
  `,
    params,
  );
  return r.rows;
};

module.exports = {
  findAll,
  findById,
  findExact,
  findActiveRate,
  findActiveInstallmentOptionsForProduct,
  findProductsWithActiveRates,
  create,
  update,
};
