const pool = require('../../config/db');

// Busca cuotas pendientes/vencidas asignadas a un cobrador para una fecha dada
const findInstallmentsForSheet = async (collectorId, date, filter) => {
  let statusFilter = `i.status IN ('PENDING','OVERDUE','PARTIAL')`;
  if (filter === 'TODAY') {
    statusFilter = `i.status IN ('PENDING','PARTIAL') AND i.due_date::date = $2::date`;
  } else if (filter === 'OVERDUE') {
    statusFilter = `i.status = 'OVERDUE'`;
  } else if (filter === 'TODAY_AND_OVERDUE') {
    statusFilter = `(i.status = 'OVERDUE' OR (i.status IN ('PENDING','PARTIAL') AND i.due_date::date = $2::date))`;
  }
  // ALL_PENDING usa el default arriba

  const r = await pool.query(
    `SELECT
       i.id AS installment_id,
       i.installment_number,
       i.due_date,
       i.amount_due,
       i.amount_paid,
       i.penalty_amount,
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
    [collectorId, date]
  );
  return r.rows;
};

const create = async ({ collectorId, date, filter, adminId }) => {
  const r = await pool.query(
    `INSERT INTO collection_sheets (collector_id, sheet_date, filter_used, generated_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, collector_id, sheet_date, filter_used, generated_by, created_at`,
    [collectorId, date, filter || 'ALL_PENDING', adminId]
  );
  return r.rows[0];
};

const createDetails = async (sheetId, items) => {
  if (!items.length) return;
  const values = items.map((item, i) => {
    const base = i * 3;
    return `($${base + 1}, $${base + 2}, $${base + 3})`;
  }).join(', ');
  const params = items.flatMap((item, i) => [sheetId, item.installment_id, i + 1]);
  await pool.query(
    `INSERT INTO collection_sheet_details (collection_sheet_id, installment_id, order_number)
     VALUES ${values}`,
    params
  );
};

const findAll = async ({ collectorId, date } = {}) => {
  let q = `
    SELECT cs.id, cs.sheet_date, cs.filter_used, cs.created_at,
           u.full_name AS collector_name,
           COUNT(csd.id) AS total_items
    FROM collection_sheets cs
    JOIN users u ON u.id = cs.collector_id
    LEFT JOIN collection_sheet_details csd ON csd.collection_sheet_id = cs.id
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
            i.id AS installment_id,
            i.installment_number,
            i.due_date,
            i.amount_due,
            i.amount_paid,
            i.penalty_amount,
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
     WHERE csd.collection_sheet_id = $1
     ORDER BY csd.order_number`,
    [id]
  );
  return { ...sheet, items: detailsRes.rows };
};

module.exports = { findInstallmentsForSheet, create, createDetails, findAll, findById };
