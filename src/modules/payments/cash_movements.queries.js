// ═══════════════════════════════════════════════════════════════════════════
// @deprecated TABLA LEGACY (cash_movements)
// ═══════════════════════════════════════════════════════════════════════════
// Cache derivado de payments — duplica información que ya vive en
// payments.cash_session_id + cash_sessions.closure_snapshot (Fase 2+).
//
// Mantenida porque el dashboard antiguo de cash_registers la consume y
// payments.service la sigue poblando dentro de la tx de approve/reverse
// (no agregar lógica nueva, no agregar nuevas dependencias).
//
// Eliminación prevista en feat/cash-system-cleanup.
// ═══════════════════════════════════════════════════════════════════════════

const pool = require('../../config/db');

/**
 * Registra un movimiento de caja dentro de una transacción activa.
 * Debe llamarse en la misma transacción que aprueba el pago para garantizar atomicidad.
 * @param {object} client - Cliente de transacción pg.
 * @param {object} params
 * @param {string} params.paymentId      - ID del payment que origina el movimiento.
 * @param {number} params.amount         - Monto del movimiento (siempre positivo).
 * @param {string} params.movementType   - 'PAYMENT' | 'REVERSAL'.
 * @param {string} params.paymentMethod  - 'CASH' | 'TRANSFER'.
 * @param {string} params.registerDate   - Fecha contable en formato 'YYYY-MM-DD'.
 * @param {string} params.createdBy      - ID del usuario que ejecuta la operación.
 */
const create = async (client, { paymentId, amount, movementType, paymentMethod, registerDate, createdBy }) => {
  await client.query(
    `INSERT INTO cash_movements
       (payment_id, amount, movement_type, payment_method, register_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [paymentId, amount, movementType, paymentMethod, registerDate, createdBy]
  );
};

/**
 * Devuelve los movimientos de caja de una fecha, agrupados por método de pago.
 * Útil para reconciliación y dashboard.
 * @param {string} date - Fecha en formato 'YYYY-MM-DD'.
 */
const getSummaryByDate = async (date) => {
  const r = await pool.query(
    `SELECT
       movement_type,
       payment_method,
       COUNT(*)::int            AS count,
       SUM(amount)::float8      AS total
     FROM cash_movements
     WHERE register_date = $1::date
     GROUP BY movement_type, payment_method
     ORDER BY movement_type, payment_method`,
    [date]
  );
  return r.rows;
};

/**
 * Devuelve el movimiento de caja de tipo PAYMENT asociado a un cobro.
 * Se usa para validar que la caja del día en que se aprobó el cobro sigue abierta
 * antes de permitir una reversión.
 * @param {object} client - Cliente de transacción pg.
 * @param {string} paymentId - ID del payment aprobado.
 * @returns {Promise<{register_date: string}|null>}
 */
const findPaymentMovement = async (client, paymentId) => {
  const r = await client.query(
    `SELECT register_date::text FROM cash_movements
     WHERE payment_id = $1 AND movement_type = 'PAYMENT'
     LIMIT 1`,
    [paymentId]
  );
  return r.rows[0] || null;
};

module.exports = { create, getSummaryByDate, findPaymentMovement };
