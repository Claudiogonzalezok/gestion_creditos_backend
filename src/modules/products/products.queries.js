const pool = require('../../config/db');

const findAll = async ({ status, search, categoryId } = {}) => {
  let q = `
    SELECT p.id, p.title, p.description, p.model, p.status, p.created_at,
           pc.id   AS category_id,  pc.name AS category_name,
           pb.id   AS brand_id,     pb.name AS brand_name,
           COALESCE(stock.available_count, 0) AS available_count,
           COALESCE(stock.reserved_count,  0) AS reserved_count,
           COALESCE(stock.sold_count,       0) AS sold_count,
           COALESCE(vars.v, '[]'::json)        AS variants
    FROM products p
    LEFT JOIN product_categories pc ON pc.id = p.category_id
    LEFT JOIN product_brands     pb ON pb.id = p.brand_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(pu.id) FILTER (WHERE pu.status = 'AVAILABLE')::int AS available_count,
        COUNT(pu.id) FILTER (WHERE pu.status = 'RESERVED')::int  AS reserved_count,
        COUNT(pu.id) FILTER (WHERE pu.status = 'SOLD')::int      AS sold_count
      FROM product_variants pv2
      JOIN product_units pu ON pu.variant_id = pv2.id
      WHERE pv2.product_id = p.id
    ) stock ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(
        jsonb_build_object(
          'id',            pv.id,
          'color',         pv.color,
          'size',          pv.size,
          'capacity',      pv.capacity,
          'current_price', pv.current_price::float8,
          'status',        pv.status
        ) ORDER BY pv.color ASC NULLS FIRST
      ) AS v
      FROM product_variants pv
      WHERE pv.product_id = p.id
    ) vars ON TRUE
    WHERE 1=1`;
  const params = [];

  if (status)     { params.push(status);        q += ` AND p.status = $${params.length}`; }
  if (search)     { params.push(`%${search}%`); q += ` AND (p.title ILIKE $${params.length} OR p.description ILIKE $${params.length})`; }
  if (categoryId) { params.push(categoryId);    q += ` AND p.category_id = $${params.length}`; }
  q += ` ORDER BY p.title ASC`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT p.id, p.title, p.description, p.model, p.status, p.created_at, p.updated_at,
            pc.id AS category_id,  pc.name AS category_name,
            pb.id AS brand_id,     pb.name AS brand_name,
            COALESCE(stock.available_count, 0) AS available_count,
            COALESCE(stock.reserved_count,  0) AS reserved_count,
            COALESCE(stock.sold_count,       0) AS sold_count,
            COALESCE(vars.v, '[]'::json)        AS variants
     FROM products p
     LEFT JOIN product_categories pc ON pc.id = p.category_id
     LEFT JOIN product_brands     pb ON pb.id = p.brand_id
     LEFT JOIN LATERAL (
       SELECT
         COUNT(pu.id) FILTER (WHERE pu.status = 'AVAILABLE')::int AS available_count,
         COUNT(pu.id) FILTER (WHERE pu.status = 'RESERVED')::int  AS reserved_count,
         COUNT(pu.id) FILTER (WHERE pu.status = 'SOLD')::int      AS sold_count
       FROM product_variants pv2
       JOIN product_units pu ON pu.variant_id = pv2.id
       WHERE pv2.product_id = p.id
     ) stock ON TRUE
     LEFT JOIN LATERAL (
       SELECT json_agg(
         jsonb_build_object(
           'id',             pv.id,
           'color',          pv.color,
           'size',           pv.size,
           'capacity',       pv.capacity,
           'current_price',  pv.current_price::float8,
           'status',         pv.status,
           'available_count', COALESCE(pv_stock.available_count, 0),
           'reserved_count',  COALESCE(pv_stock.reserved_count,  0),
           'sold_count',      COALESCE(pv_stock.sold_count,       0)
         ) ORDER BY pv.color ASC NULLS FIRST
       ) AS v
       FROM product_variants pv
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*) FILTER (WHERE status = 'AVAILABLE')::int AS available_count,
           COUNT(*) FILTER (WHERE status = 'RESERVED')::int  AS reserved_count,
           COUNT(*) FILTER (WHERE status = 'SOLD')::int      AS sold_count
         FROM product_units WHERE variant_id = pv.id
       ) pv_stock ON TRUE
       WHERE pv.product_id = p.id
     ) vars ON TRUE
     WHERE p.id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

const findActiveCategoryById = async (id) => {
  const r = await pool.query(
    `SELECT id FROM product_categories WHERE id = $1 AND active = TRUE`, [id]
  );
  return r.rows[0] || null;
};

const findActiveBrandById = async (id) => {
  const r = await pool.query(
    `SELECT id FROM product_brands WHERE id = $1 AND active = TRUE`, [id]
  );
  return r.rows[0] || null;
};

const findByTitle = async (title) => {
  const r = await pool.query(
    `SELECT id FROM products WHERE LOWER(title) = LOWER($1)`, [title]
  );
  return r.rows[0] || null;
};

/**
 * Devuelve true si el producto tiene unidades RESERVED o SOLD (bloqueo por defecto).
 */
const hasActiveCredits = async (id) => {
  const r = await pool.query(
    `SELECT pu.id FROM product_units pu
     JOIN product_variants pv ON pv.id = pu.variant_id
     WHERE pv.product_id = $1 AND pu.status IN ('RESERVED', 'SOLD')
     LIMIT 1`,
    [id]
  );
  return r.rows.length > 0;
};

/**
 * Devuelve true si el producto tiene unidades RESERVED (créditos pendientes activos).
 * Usado en modo force=true para bloquear solo casos críticos.
 */
const hasReservedUnits = async (id) => {
  const r = await pool.query(
    `SELECT pu.id FROM product_units pu
     JOIN product_variants pv ON pv.id = pu.variant_id
     WHERE pv.product_id = $1 AND pu.status = 'RESERVED'
     LIMIT 1`,
    [id]
  );
  return r.rows.length > 0;
};

/**
 * Crea un producto y retorna el registro completo con nombre de categoría y marca.
 * Usa read-after-write sobre findById para garantizar una respuesta consistente.
 */
const create = async ({ title, description, model, brand_id, category_id }) => {
  const r = await pool.query(
    `INSERT INTO products (title, description, model, brand_id, category_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [title, description || null, model || null, brand_id || null, category_id || null]
  );
  return await findById(r.rows[0].id);
};

/**
 * Actualiza un producto y retorna el registro completo con nombre de categoría y marca.
 * Usa read-after-write sobre findById para garantizar una respuesta consistente.
 * @returns {Object|null} producto actualizado o null si no existe
 */
const update = async (id, { title, description, model, brand_id, category_id } = {}) => {
  const params = [];
  const sets   = [];

  if (title       !== undefined) { params.push(title);       sets.push(`title = $${params.length}`); }
  if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
  if (model       !== undefined) { params.push(model);       sets.push(`model = $${params.length}`); }
  if (brand_id    !== undefined) { params.push(brand_id);    sets.push(`brand_id = $${params.length}`); }
  if (category_id !== undefined) { params.push(category_id); sets.push(`category_id = $${params.length}`); }

  if (!sets.length) return findById(id);

  params.push(id);
  const r = await pool.query(
    `UPDATE products SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING id`,
    params
  );
  if (!r.rows[0]) return null;
  return findById(r.rows[0].id);
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
  findAll, findById, findByTitle,
  findActiveCategoryById, findActiveBrandById,
  hasActiveCredits, hasReservedUnits, create, update, deactivate, activate,
};
