const pool = require('../../config/db');

/**
 * Registra un intento de cobranza sin cobro.
 * @param {{ installmentId, collectorId, createdBy, attemptType, reason, nextVisitDate, notes }} data
 * @returns {Promise<object>}
 */
const create = async ({ installmentId, collectorId, createdBy, attemptType, reason, nextVisitDate, notes }) => {
  const r = await pool.query(
    `INSERT INTO collection_attempts
       (installment_id, collector_id, created_by, attempt_type, reason, next_visit_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, installment_id, collector_id, created_by, attempt_type,
               reason, next_visit_date, notes, created_at`,
    [installmentId, collectorId, createdBy, attemptType, reason || null, nextVisitDate || null, notes || null]
  );
  return r.rows[0];
};

/**
 * Lista intentos de cobranza con filtros opcionales.
 * @param {{ collectorId?: string, installmentId?: string }} filters
 * @returns {Promise<Array>}
 */
const findAll = async ({ collectorId, installmentId } = {}) => {
  let q = `
    SELECT ca.id, ca.attempt_type, ca.reason, ca.next_visit_date, ca.notes, ca.created_at,
           ca.installment_id, ca.collector_id, ca.created_by,
           ca.voided_at, ca.voided_by,
           i.installment_number, i.due_date, i.amount_due::float8, i.amount_paid::float8, i.status AS installment_status,
           c.id AS credit_id, c.type AS credit_type,
           cu.full_name AS customer_name, cu.dni AS customer_dni,
           u.full_name AS collector_name
    FROM collection_attempts ca
    JOIN installments i  ON i.id  = ca.installment_id
    JOIN credits c       ON c.id  = i.credit_id
    JOIN customers cu    ON cu.id = c.customer_id
    JOIN users u         ON u.id  = ca.collector_id
    WHERE 1=1`;
  const params = [];
  if (collectorId)   { params.push(collectorId);   q += ` AND ca.collector_id = $${params.length}`; }
  if (installmentId) { params.push(installmentId); q += ` AND ca.installment_id = $${params.length}`; }
  q += ` ORDER BY ca.created_at DESC`;
  return (await pool.query(q, params)).rows;
};

/**
 * Obtiene un intento de cobranza por ID con detalle completo.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
const findById = async (id) => {
  const r = await pool.query(
    `SELECT ca.id, ca.attempt_type, ca.reason, ca.next_visit_date, ca.notes, ca.created_at,
            ca.installment_id, ca.collector_id, ca.created_by,
            ca.voided_at, ca.voided_by,
            i.installment_number, i.due_date, i.amount_due::float8, i.amount_paid::float8, i.status AS installment_status,
            c.id AS credit_id, c.type AS credit_type,
            cu.full_name AS customer_name, cu.dni AS customer_dni, cu.phone AS customer_phone,
            u.full_name AS collector_name
     FROM collection_attempts ca
     JOIN installments i  ON i.id  = ca.installment_id
     JOIN credits c       ON c.id  = i.credit_id
     JOIN customers cu    ON cu.id = c.customer_id
     JOIN users u         ON u.id  = ca.collector_id
     WHERE ca.id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

/**
 * Devuelve el registro crudo (sin joins) — usado por el service para validar
 * ownership y reglas de anulación (mismo día, mismo cobrador, no anulado).
 */
const findRawById = async (id) => {
  const r = await pool.query(
    `SELECT id, installment_id, collector_id, created_by, attempt_type,
            created_at, voided_at, voided_by
     FROM collection_attempts
     WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

/**
 * Marca un intento como anulado (supersede pattern). No realiza DELETE físico.
 * El intento sigue visible en el management log con badge "ANULADO".
 */
const markVoided = async (id, voidedBy) => {
  const r = await pool.query(
    `UPDATE collection_attempts
     SET voided_at = NOW(), voided_by = $2
     WHERE id = $1
     RETURNING id, voided_at, voided_by`,
    [id, voidedBy]
  );
  return r.rows[0] || null;
};

/**
 * Anula todas las gestiones vigentes con próxima visita de una cuota (supersede en
 * lote). Se usa al renovar un préstamo: la visita agendada queda obsoleta porque el
 * crédito corrió su vencimiento. Como el CTE latest_next_visit filtra voided_at IS
 * NULL, anularlas equivale a resetear la próxima visita. Transaccional (recibe client).
 * @param {object} client - Cliente de transacción.
 * @param {string} installmentId - Cuota cuya próxima visita se resetea.
 * @param {string} voidedBy - Usuario que ejecuta el reset.
 */
const voidScheduledVisitsForInstallment = async (
  client,
  installmentId,
  voidedBy,
) => {
  await client.query(
    `UPDATE collection_attempts
       SET voided_at = NOW(), voided_by = $2
     WHERE installment_id = $1
       AND next_visit_date IS NOT NULL
       AND voided_at IS NULL`,
    [installmentId, voidedBy],
  );
};

module.exports = {
  create,
  findAll,
  findById,
  findRawById,
  markVoided,
  voidScheduledVisitsForInstallment,
};
