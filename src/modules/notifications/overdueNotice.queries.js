const NOTICE_COLUMNS = `id, installment_id, customer_id, channel, recipient,
  amount_due::float8 AS amount_due, sent_by, notified_on::text AS notified_on, created_at`;

/**
 * Cuota con su crédito y cliente, bloqueando la cuota (serializa avisos
 * concurrentes de la misma cuota).
 * @param {Object} client - client de transacción
 * @param {string} installmentId
 * @returns {Promise<object|null>}
 */
const findInstallmentForNotice = async (client, installmentId) => {
  const r = await client.query(
    `SELECT i.id, i.installment_number, i.due_date::text AS due_date, i.status,
            (i.amount_due - i.amount_paid)::float8 AS remaining,
            c.id AS credit_id,
            cu.id AS customer_id, cu.full_name AS customer_name, cu.email AS customer_email,
            cu.assigned_collector_id
     FROM installments i
     JOIN credits c    ON c.id = i.credit_id
     JOIN customers cu ON cu.id = c.customer_id
     WHERE i.id = $1
     FOR UPDATE OF i`,
    [installmentId]
  );
  return r.rows[0] || null;
};

/**
 * Inserta el aviso del día; null si ya existía uno para esa cuota y fecha.
 * @param {Object} client
 * @param {object} data
 * @returns {Promise<object|null>}
 */
const insertNotice = async (client, { installmentId, customerId, recipient, amountDue, sentBy, notifiedOn }) => {
  const r = await client.query(
    `INSERT INTO customer_overdue_notices
       (installment_id, customer_id, recipient, amount_due, sent_by, notified_on)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (installment_id, notified_on) DO NOTHING
     RETURNING ${NOTICE_COLUMNS}`,
    [installmentId, customerId, recipient, amountDue, sentBy, notifiedOn]
  );
  return r.rows[0] || null;
};

/**
 * Aviso existente de una cuota en una fecha.
 * @param {Object} client
 * @param {string} installmentId
 * @param {string} notifiedOn - YYYY-MM-DD
 * @returns {Promise<object|null>}
 */
const findNotice = async (client, installmentId, notifiedOn) => {
  const r = await client.query(
    `SELECT ${NOTICE_COLUMNS} FROM customer_overdue_notices
     WHERE installment_id = $1 AND notified_on = $2`,
    [installmentId, notifiedOn]
  );
  return r.rows[0] || null;
};

module.exports = { findInstallmentForNotice, insertNotice, findNotice };
