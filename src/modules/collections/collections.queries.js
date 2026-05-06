const pool = require('../../config/db');

/**
 * Busca cuotas pendientes/vencidas asignadas a un cobrador para una fecha dada.
 * Permite ejecutar dentro de transacción cuando se pasa un cliente de BD.
 * @param {string} collectorId - ID del cobrador.
 * @param {string} date - Fecha de referencia de la planilla.
 * @param {string} filter - Filtro de cuotas a incluir.
 * @param {import('pg').Pool|import('pg').PoolClient} [db=pool] - Conexión o cliente para ejecutar la query.
 * @returns {Promise<Array<object>>} Lista de cuotas candidatas a incluir en la planilla.
 */
const findInstallmentsForSheet = async (collectorId, date, filter, db = pool) => {
  let statusFilter;
  let params;

  if (filter === 'TODAY') {
    statusFilter = `i.status IN ('PENDING','PARTIAL') AND i.due_date::date = $2::date`;
    params = [collectorId, date];
  } else if (filter === 'OVERDUE') {
    statusFilter = `i.status = 'OVERDUE'`;
    params = [collectorId];
  } else if (filter === 'TODAY_AND_OVERDUE') {
    statusFilter = `(i.status = 'OVERDUE' OR (i.status IN ('PENDING','PARTIAL') AND i.due_date::date = $2::date))`;
    params = [collectorId, date];
  } else {
    // ALL_PENDING
    statusFilter = `i.status IN ('PENDING','OVERDUE','PARTIAL')`;
    params = [collectorId];
  }

  const r = await db.query(
    `SELECT
       i.id AS installment_id,
       i.installment_number,
       i.due_date,
       i.amount_due::float8,
       i.amount_paid::float8,
       i.penalty_amount::float8,
       i.status AS installment_status,
       c.id AS credit_id,
       c.type AS credit_type,
       cu.id AS customer_id,
       cu.full_name AS customer_name,
       cu.phone AS customer_phone,
       cu.address AS customer_address
     FROM installments i
     JOIN credits c    ON c.id  = i.credit_id
     JOIN customers cu ON cu.id = c.customer_id
     WHERE c.status = 'ACTIVE'
       AND cu.assigned_collector_id = $1
       AND ${statusFilter}
     ORDER BY cu.full_name, i.due_date`,
    params
  );
  return r.rows;
};

/**
 * Crea la cabecera de una planilla de cobro.
 * @param {{ collectorId: string, date: string, filter: string, adminId: string }} payload - Datos de creación.
 * @param {import('pg').Pool|import('pg').PoolClient} [db=pool] - Conexión o cliente para ejecutar la query.
 * @returns {Promise<object>} Cabecera de planilla recién creada.
 */
const create = async ({ collectorId, date, filter, adminId }, db = pool) => {
  const r = await db.query(
    `INSERT INTO collection_sheets (collector_id, sheet_date, filter_used, generated_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, collector_id, sheet_date, filter_used, generated_by, created_at`,
    [collectorId, date, filter || 'ALL_PENDING', adminId]
  );
  return r.rows[0];
};

/**
 * Inserta los detalles de una planilla usando snapshot del monto al momento de emisión.
 * @param {string} sheetId - ID de la planilla.
 * @param {Array<object>} items - Cuotas incluidas en la planilla.
 * @param {import('pg').Pool|import('pg').PoolClient} [db=pool] - Conexión o cliente para ejecutar la query.
 */
const createDetails = async (sheetId, items, db = pool) => {
  if (!items.length) return;
  const values = items.map((item, i) => {
    const base = i * 4;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
  }).join(', ');
  const params = items.flatMap((item, i) => [
    sheetId,
    item.installment_id,
    i + 1,
    item.amount_due,   // planned_amount — snapshot del monto al emitir la planilla
  ]);
  await db.query(
    `INSERT INTO collection_sheet_details (sheet_id, installment_id, order_number, planned_amount)
     VALUES ${values}`,
    params
  );
};

const findAll = async ({ collectorId, date } = {}) => {
  let q = `
    SELECT cs.id, cs.sheet_date, cs.filter_used, cs.created_at,
           u.full_name AS collector_name,
           COUNT(csd.id)::int AS total_items
    FROM collection_sheets cs
    JOIN users u ON u.id = cs.collector_id
    LEFT JOIN collection_sheet_details csd ON csd.sheet_id = cs.id
    WHERE 1=1`;
  const params = [];
  if (collectorId) { params.push(collectorId); q += ` AND cs.collector_id = $${params.length}`; }
  if (date)        { params.push(date);        q += ` AND cs.sheet_date::date = $${params.length}::date`; }
  q += ` GROUP BY cs.id, u.full_name ORDER BY cs.created_at DESC`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const sheetRes = await pool.query(
    `SELECT cs.id, cs.sheet_date, cs.filter_used, cs.created_at,
            u.full_name AS collector_name, u.id AS collector_id,
            adm.full_name AS generated_by_name
     FROM collection_sheets cs
     JOIN users u   ON u.id  = cs.collector_id
     JOIN users adm ON adm.id = cs.generated_by
     WHERE cs.id = $1`,
    [id]
  );
  if (!sheetRes.rows.length) return null;
  const sheet = sheetRes.rows[0];

  const detailsRes = await pool.query(
    `SELECT csd.order_number,
            csd.planned_amount::float8,
            i.id AS installment_id,
            i.installment_number,
            i.due_date,
            i.amount_due::float8,
            i.amount_paid::float8,
            i.penalty_amount::float8,
            i.status AS installment_status,
            c.id AS credit_id,
            c.type AS credit_type,
            cu.full_name AS customer_name,
            cu.phone AS customer_phone,
            cu.address AS customer_address
     FROM collection_sheet_details csd
     JOIN installments i ON i.id  = csd.installment_id
     JOIN credits c      ON c.id  = i.credit_id
     JOIN customers cu   ON cu.id = c.customer_id
     WHERE csd.sheet_id = $1
     ORDER BY csd.order_number`,
    [id]
  );
  return { ...sheet, items: detailsRes.rows };
};

module.exports = { findInstallmentsForSheet, create, createDetails, findAll, findById };
