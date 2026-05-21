const pool = require('../../config/db');

// =============================================================================
// CTE latest_next_visit — construida y documentada de forma aislada
//
// Fuente de verdad: ÚLTIMO registro creado por cuota (created_at DESC).
// NO la fecha más lejana — el último intento registrado es el que manda.
//
// Unifica dos orígenes:
//   payments        (status='PENDING', next_visit_date IS NOT NULL, is_reversal=FALSE)
//   collection_attempts (next_visit_date IS NOT NULL)
//
// Resultado por cuota: installment_id, next_visit_date más reciente.
// =============================================================================
const CTE_LATEST_NEXT_VISIT = `
  latest_next_visit AS (
    SELECT DISTINCT ON (installment_id)
      installment_id,
      next_visit_date
    FROM (
      SELECT installment_id, next_visit_date, created_at
      FROM payments
      WHERE status = 'PENDING'
        AND next_visit_date IS NOT NULL
        AND is_reversal = FALSE
      UNION ALL
      SELECT installment_id, next_visit_date, created_at
      FROM collection_attempts
      WHERE next_visit_date IS NOT NULL
    ) combined_visits
    ORDER BY installment_id, created_at DESC
  )
`;

// =============================================================================
// CTE latest_antecedent — construida y documentada de forma aislada
//
// Snapshot del último intento previo por cuota, para mostrar contexto en planilla.
// Incluye NOT_FOUND aunque no tenga next_visit_date (se muestra igual como antecedente).
//
// Unifica dos orígenes:
//   payments (next_visit_date IS NOT NULL, is_reversal=FALSE) → antecedent_type = 'PARTIAL_PAYMENT'
//   collection_attempts (todos)                               → antecedent_type = attempt_type
//
// Resultado: installment_id, antecedent_type, antecedent_date, antecedent_notes.
// =============================================================================
const CTE_LATEST_ANTECEDENT = `
  latest_antecedent AS (
    SELECT DISTINCT ON (installment_id)
      installment_id,
      antecedent_type,
      antecedent_date,
      antecedent_notes
    FROM (
      SELECT
        p.installment_id,
        'PARTIAL_PAYMENT'   AS antecedent_type,
        p.created_at::date  AS antecedent_date,
        p.notes             AS antecedent_notes,
        p.created_at
      FROM payments p
      WHERE p.next_visit_date IS NOT NULL
        AND p.is_reversal = FALSE
      UNION ALL
      SELECT
        ca.installment_id,
        ca.attempt_type     AS antecedent_type,
        ca.created_at::date AS antecedent_date,
        ca.notes            AS antecedent_notes,
        ca.created_at
      FROM collection_attempts ca
    ) combined_antecedents
    ORDER BY installment_id, created_at DESC
  )
`;

/**
 * Busca cuotas para incluir en una planilla de cobro.
 * Aplica lógica de próxima visita: excluye cuotas con visita futura,
 * incluye cuotas con visita vencida/hoy o sin visita registrada.
 *
 * Parámetros siempre: $1 = collectorId, $2 = date.
 * Fuente de verdad del next_visit_date: último registro creado (created_at DESC), no la fecha más lejana.
 *
 * @param {string} collectorId
 * @param {string} date - Fecha de la planilla (YYYY-MM-DD).
 * @param {string} filter - TODAY | OVERDUE | TODAY_AND_OVERDUE | ALL_PENDING
 * @param {import('pg').Pool|import('pg').PoolClient} [db=pool]
 * @returns {Promise<Array>}
 */
const findInstallmentsForSheet = async (collectorId, date, filter, db = pool) => {
  // $1 = collectorId, $2 = date — siempre presentes para la condición de next_visit_date
  const params = [collectorId, date];

  let statusFilter;
  if (filter === 'TODAY') {
    statusFilter = `i.status IN ('PENDING','PARTIAL') AND i.due_date::date = $2::date`;
  } else if (filter === 'OVERDUE') {
    statusFilter = `i.status = 'OVERDUE'`;
  } else if (filter === 'TODAY_AND_OVERDUE') {
    statusFilter = `(i.status = 'OVERDUE' OR (i.status IN ('PENDING','PARTIAL') AND i.due_date::date = $2::date))`;
  } else {
    // ALL_PENDING — incluye todo lo pendiente sin filtrar por fecha de vencimiento
    statusFilter = `i.status IN ('PENDING','OVERDUE','PARTIAL')`;
  }

  const r = await db.query(
    `WITH
      ${CTE_LATEST_NEXT_VISIT},
      ${CTE_LATEST_ANTECEDENT}
     SELECT
       i.id                  AS installment_id,
       i.installment_number,
       i.due_date,
       i.amount_due::float8,
       i.amount_paid::float8,
       i.penalty_amount::float8,
       i.status              AS installment_status,
       c.id                  AS credit_id,
       c.type                AS credit_type,
       cu.id                 AS customer_id,
       cu.full_name          AS customer_name,
       cu.phone              AS customer_phone,
       cu.address            AS customer_address,
       lnv.next_visit_date,
       CASE
         WHEN lnv.next_visit_date = $2::date THEN 'VISIT_DATE'
         ELSE 'DUE_DATE'
       END                   AS inclusion_criteria,
       la.antecedent_type,
       la.antecedent_date,
       la.antecedent_notes
     FROM installments i
     JOIN credits c    ON c.id  = i.credit_id
     JOIN customers cu ON cu.id = c.customer_id
     LEFT JOIN latest_next_visit lnv ON lnv.installment_id = i.id
     LEFT JOIN latest_antecedent la  ON la.installment_id  = i.id
     WHERE c.status = 'ACTIVE'
       AND cu.assigned_collector_id = $1
       AND ${statusFilter}
       AND (
         lnv.next_visit_date IS NULL           -- sin compromiso: incluir por vencimiento
         OR lnv.next_visit_date <= $2::date    -- compromiso hoy o ya vencido: incluir
         -- next_visit_date > $2 → excluida hasta que llegue ese día
       )
     ORDER BY cu.full_name, i.due_date`,
    params
  );
  return r.rows;
};

/**
 * Crea la cabecera de una planilla de cobro.
 * @param {{ collectorId, date, filter, adminId }} payload
 * @param {import('pg').PoolClient} [db=pool]
 * @returns {Promise<object>}
 */
const create = async ({ collectorId, date, filter, adminId }, db = pool) => {
  const r = await db.query(
    `INSERT INTO collection_sheets (collector_id, sheet_date, filter_used, generated_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, collector_id, sheet_date, filter_used, generated_by, status, created_at`,
    [collectorId, date, filter || 'ALL_PENDING', adminId]
  );
  return r.rows[0];
};

/**
 * Inserta los detalles de una planilla con snapshot del monto y datos de antecedente.
 * @param {string} sheetId
 * @param {Array<object>} items - Items de findInstallmentsForSheet (incluyen los campos nuevos)
 * @param {import('pg').PoolClient} [db=pool]
 */
const createDetails = async (sheetId, items, db = pool) => {
  if (!items.length) return;
  const values = items.map((_, i) => {
    const b = i * 8;
    return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7}, $${b+8})`;
  }).join(', ');
  const params = items.flatMap((item, i) => [
    sheetId,
    item.installment_id,
    i + 1,
    item.amount_due,                       // planned_amount — snapshot al momento de emisión
    item.inclusion_criteria || 'DUE_DATE',
    item.antecedent_type    || null,
    item.antecedent_date    || null,
    item.antecedent_notes   || null,
  ]);
  await db.query(
    `INSERT INTO collection_sheet_details
       (sheet_id, installment_id, order_number, planned_amount,
        inclusion_criteria, antecedent_type, antecedent_date, antecedent_notes)
     VALUES ${values}`,
    params
  );
};

/**
 * Marca una planilla como REGENERATED (soft-delete).
 * Los collection_sheet_details NO se eliminan — el historial se preserva completo.
 * @param {string} id - ID de la planilla a marcar.
 * @param {import('pg').PoolClient} client
 */
const markSheetAsRegenerated = async (id, client) => {
  await client.query(
    `UPDATE collection_sheets SET status = 'REGENERATED' WHERE id = $1`,
    [id]
  );
};

/**
 * Lista planillas con filtros opcionales.
 * Por defecto devuelve solo ACTIVE; con includeRegenerated=true suma las REGENERATED
 * para auditoría (filtro exclusivo del Admin, restringido en service).
 * @param {{ collectorId?: string, date?: string, includeRegenerated?: boolean }} filters
 * @returns {Promise<Array>}
 */
const findAll = async ({ collectorId, date, includeRegenerated } = {}) => {
  const statusFilter = includeRegenerated
    ? `cs.status IN ('ACTIVE','REGENERATED')`
    : `cs.status = 'ACTIVE'`;
  let q = `
    SELECT cs.id, cs.sheet_date, cs.filter_used, cs.status, cs.created_at,
           u.full_name AS collector_name,
           COUNT(csd.id)::int AS total_items
    FROM collection_sheets cs
    JOIN users u ON u.id = cs.collector_id
    LEFT JOIN collection_sheet_details csd ON csd.sheet_id = cs.id
    WHERE ${statusFilter}`;
  const params = [];
  if (collectorId) { params.push(collectorId); q += ` AND cs.collector_id = $${params.length}`; }
  if (date)        { params.push(date);        q += ` AND cs.sheet_date::date = $${params.length}::date`; }
  q += ` GROUP BY cs.id, u.full_name ORDER BY cs.created_at DESC`;
  return (await pool.query(q, params)).rows;
};

/**
 * Obtiene una planilla por ID con detalle completo.
 * Devuelve cualquier status (ACTIVE o REGENERATED) para permitir auditoría.
 * La restricción por rol se aplica en el service.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
const findById = async (id) => {
  const sheetRes = await pool.query(
    `SELECT cs.id, cs.sheet_date, cs.filter_used, cs.status, cs.created_at,
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

  // Trae next_visit_date actualizado vía CTE (último registro en payments o collection_attempts).
  // El criterio de inclusión inicial quedó snapshoteado en csd.inclusion_criteria al generar la planilla.
  const detailsRes = await pool.query(
    `WITH ${CTE_LATEST_NEXT_VISIT}
     SELECT csd.order_number,
            csd.planned_amount::float8,
            csd.inclusion_criteria,
            csd.antecedent_type,
            csd.antecedent_date,
            csd.antecedent_notes,
            csd.management_status,
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
            cu.address AS customer_address,
            lnv.next_visit_date
     FROM collection_sheet_details csd
     JOIN installments i ON i.id  = csd.installment_id
     JOIN credits c      ON c.id  = i.credit_id
     JOIN customers cu   ON cu.id = c.customer_id
     LEFT JOIN latest_next_visit lnv ON lnv.installment_id = i.id
     WHERE csd.sheet_id = $1
     ORDER BY csd.order_number`,
    [id]
  );
  return { ...sheet, items: detailsRes.rows };
};

/**
 * Devuelve clientes activos con cuotas pendientes sin cobrador asignado.
 * Alerta global del sistema (CU14-D): independiente del cobrador que genera la planilla.
 * @returns {Promise<Array<{ customer_id, full_name, pending_count }>>}
 */
const findUnassignedCustomersWithPending = async () => {
  const r = await pool.query(
    `SELECT cu.id AS customer_id, cu.full_name, COUNT(i.id)::int AS pending_count
     FROM customers cu
     JOIN credits c   ON c.customer_id = cu.id
     JOIN installments i ON i.credit_id = c.id
     WHERE cu.assigned_collector_id IS NULL
       AND c.status = 'ACTIVE'
       AND i.status IN ('PENDING','OVERDUE','PARTIAL')
     GROUP BY cu.id, cu.full_name
     ORDER BY cu.full_name`
  );
  return r.rows;
};

module.exports = {
  findInstallmentsForSheet,
  create,
  createDetails,
  markSheetAsRegenerated,
  findAll,
  findById,
  findUnassignedCustomersWithPending,
};
