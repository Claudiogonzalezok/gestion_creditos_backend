// Paginación opcional de listados (issue #38).
//
// Contrato:
//   · Sin `limit`, `offset` ni `page` en la query → el listado se comporta
//     exactamente como antes (array completo en `data`), para no romper al
//     frontend actual.
//   · Con cualquiera de ellos → `data` trae solo la página pedida y la
//     respuesta agrega `pagination: { total, limit, offset }`.
//   · `limit` tiene un tope (MAX_LIMIT); `offset` y `page` se excluyen entre sí
//     en la práctica: si viene `offset` se usa, si no se calcula desde `page`.

const { query } = require('express-validator');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_OFFSET = 1000000;
const MAX_PAGE = 100000;

const present = (v) => v !== undefined && v !== null && v !== '';

/**
 * Reglas express-validator para limit/offset/page opcionales con tope.
 * @param {{ maxLimit?: number }} [opts]
 * @returns {Array} cadenas de validación
 */
const paginationRules = ({ maxLimit = MAX_LIMIT } = {}) => [
  query('limit').optional()
    .isInt({ min: 1, max: maxLimit })
    .withMessage(`limit debe ser un entero entre 1 y ${maxLimit}.`),
  query('offset').optional()
    .isInt({ min: 0, max: MAX_OFFSET })
    .withMessage(`offset debe ser un entero entre 0 y ${MAX_OFFSET}.`),
  query('page').optional()
    .isInt({ min: 1, max: MAX_PAGE })
    .withMessage(`page debe ser un entero entre 1 y ${MAX_PAGE}.`),
];

/**
 * Traduce la query a { limit, offset }. Devuelve null si no se pidió paginar.
 * Los valores ya vienen validados por paginationRules; igual se acotan como
 * defensa en profundidad.
 * @param {object} q - req.query
 * @param {{ maxLimit?: number, defaultLimit?: number }} [opts]
 * @returns {{ limit: number, offset: number } | null}
 */
const parsePagination = (q = {}, { maxLimit = MAX_LIMIT, defaultLimit = DEFAULT_LIMIT } = {}) => {
  if (!present(q.limit) && !present(q.offset) && !present(q.page)) return null;
  const rawLimit = present(q.limit) ? parseInt(q.limit, 10) : defaultLimit;
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : defaultLimit, 1), maxLimit);
  let offset;
  if (present(q.offset)) {
    offset = parseInt(q.offset, 10);
  } else {
    const page = parseInt(q.page, 10);
    offset = ((Number.isFinite(page) && page > 0 ? page : 1) - 1) * limit;
  }
  offset = Math.min(Math.max(Number.isFinite(offset) ? offset : 0, 0), MAX_OFFSET * 10);
  return { limit, offset };
};

/**
 * Ejecuta un SELECT de listado. Sin paginación devuelve las filas tal cual;
 * con paginación agrega LIMIT/OFFSET y cuenta el total sobre la misma query.
 * @param {string} sql - SELECT completo, con su ORDER BY
 * @param {Array} params - parámetros posicionales del SELECT
 * @param {{ limit: number, offset: number } | null | undefined} pagination
 * @param {object} [db] - pool o cliente; por defecto el pool (carga diferida
 *   para que importar este helper no abra conexiones en tests unitarios)
 * @returns {Promise<Array|{ items: Array, total: number, limit: number, offset: number }>}
 */
const runListQuery = async (sql, params, pagination, db = require('../config/db')) => {
  if (!pagination) return (await db.query(sql, params)).rows;
  const { limit, offset } = pagination;
  const n = params.length;
  const [count, page] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS total FROM (${sql}) AS paginated_src`, params),
    db.query(`${sql} LIMIT $${n + 1} OFFSET $${n + 2}`, [...params, limit, offset]),
  ]);
  return { items: page.rows, total: count.rows[0].total, limit, offset };
};

/**
 * Responde un listado: array plano si no hubo paginación, o la página en
 * `data` más `pagination` si la hubo.
 * @param {object} res - respuesta express
 * @param {Array|{ items: Array, total: number, limit: number, offset: number }} result
 * @param {string} [message='OK']
 */
const sendList = (res, result, message = 'OK') => {
  if (Array.isArray(result)) return res.status(200).json({ ok: true, message, data: result });
  const { items, total, limit, offset } = result;
  return res.status(200).json({
    ok: true,
    message,
    data: items,
    pagination: { total, limit, offset },
  });
};

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  paginationRules,
  parsePagination,
  runListQuery,
  sendList,
};
