/** Tablas con movimientos de negocio que referencian `cash_session_id` pero NO deben borrarse físicamente. */
const MOVEMENT_TABLES = [
  "payments",
  "credit_down_payments",
  "expenses",
  "cash_conversions",
  "commission_liquidations",
];

/**
 * Devuelve los ids de las cajas operativas (`cash_sessions`) de una jornada.
 * @param {object} client Cliente PG dentro de transacción.
 * @param {string} businessDayId Id de la jornada (`business_days.id`).
 * @returns {Promise<string[]>} Ids de cajas asociadas a la jornada.
 */
const findCashSessionIdsByBusinessDay = async (client, businessDayId) => {
  const r = await client.query(
    `SELECT id FROM cash_sessions WHERE business_day_id = $1`,
    [businessDayId],
  );
  return r.rows.map((row) => row.id);
};

/**
 * Desvincula (sin borrar) los movimientos de negocio que apuntaban a las
 * cajas a eliminar, dejando `cash_session_id = NULL`.
 * @param {object} client Cliente PG dentro de transacción.
 * @param {string[]} sessionIds Ids de cajas a desvincular.
 */
const unlinkMovements = async (client, sessionIds) => {
  if (sessionIds.length === 0) return;
  for (const table of MOVEMENT_TABLES) {
    await client.query(
      `UPDATE ${table} SET cash_session_id = NULL WHERE cash_session_id = ANY($1::uuid[])`,
      [sessionIds],
    );
  }
};

/**
 * Desvincula (sin borrar) los créditos LOAN cuyo desembolso apuntaba a las
 * cajas a eliminar, dejando `disbursement_cash_session_id = NULL`. Columna
 * distinta a `cash_session_id` (no entra en MOVEMENT_TABLES) — requiere su
 * propio UPDATE antes de poder borrar las cajas (FK RESTRICT).
 * @param {object} client Cliente PG dentro de transacción.
 * @param {string[]} sessionIds Ids de cajas a desvincular.
 */
const unlinkCreditDisbursements = async (client, sessionIds) => {
  if (sessionIds.length === 0) return;
  await client.query(
    `UPDATE credits SET disbursement_cash_session_id = NULL WHERE disbursement_cash_session_id = ANY($1::uuid[])`,
    [sessionIds],
  );
};

/**
 * Borra los registros de caja dependientes de las cajas indicadas
 * (drops, ingresos manuales, detalle de cierre).
 * @param {object} client Cliente PG dentro de transacción.
 * @param {string[]} sessionIds Ids de cajas cuyos dependientes se borran.
 */
const deleteSessionChildren = async (client, sessionIds) => {
  if (sessionIds.length === 0) return;
  await client.query(
    `DELETE FROM cash_session_manual_incomes WHERE cash_session_id = ANY($1::uuid[])`,
    [sessionIds],
  );
  await client.query(
    `DELETE FROM cash_session_closure_details WHERE cash_session_id = ANY($1::uuid[])`,
    [sessionIds],
  );
  await client.query(
    `DELETE FROM cash_session_drops WHERE cash_session_id = ANY($1::uuid[])`,
    [sessionIds],
  );
};

/**
 * Borra las cajas operativas de una jornada.
 * @param {object} client Cliente PG dentro de transacción.
 * @param {string} businessDayId Id de la jornada.
 */
const deleteCashSessions = async (client, businessDayId) => {
  await client.query(`DELETE FROM cash_sessions WHERE business_day_id = $1`, [
    businessDayId,
  ]);
};

/**
 * Borra una jornada.
 * @param {object} client Cliente PG dentro de transacción.
 * @param {string} businessDayId Id de la jornada a borrar.
 */
const deleteBusinessDay = async (client, businessDayId) => {
  await client.query(`DELETE FROM business_days WHERE id = $1`, [
    businessDayId,
  ]);
};

/**
 * Fuerza `due_date` de una cuota y limpia su rastro de mora previa, para que
 * el cron `overdueInstallments` la trate como recién vencida desde cero.
 * @param {object} client Cliente PG dentro de transacción.
 * @param {string} installmentId Id de la cuota a manipular.
 * @param {string} dueDate Fecha YYYY-MM-DD a forzar como vencimiento.
 * @returns {Promise<object|undefined>} Cuota actualizada, o undefined si no existe.
 */
const forceInstallmentDueDate = async (client, installmentId, dueDate) => {
  const r = await client.query(
    `UPDATE installments
     SET due_date = $2::date,
         last_penalty_applied_at = NULL,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [installmentId, dueDate],
  );
  return r.rows[0];
};

/**
 * Borra todas las liquidaciones de comisiones de un usuario (E2E de
 * liquidación semanal, libera el constraint único por período).
 * @param {object} client Cliente PG dentro de transacción.
 * @param {string} userId Id del usuario liquidado.
 * @returns {Promise<number>} Cantidad de filas borradas.
 */
const deleteCommissionLiquidations = async (client, userId) => {
  const r = await client.query(
    `DELETE FROM commission_liquidations WHERE user_id = $1`,
    [userId],
  );
  return r.rowCount;
};

/**
 * Fuerza `created_at` de un crédito (E2E del cron `creditExpiry`).
 * @param {object} client Cliente PG dentro de transacción.
 * @param {string} creditId Id del crédito a manipular.
 * @param {string} createdAt Fecha ISO8601 a forzar como alta.
 * @returns {Promise<object|undefined>} Crédito actualizado, o undefined si no existe.
 */
const forceCreditCreatedAt = async (client, creditId, createdAt) => {
  const r = await client.query(
    `UPDATE credits SET created_at = $2::timestamptz WHERE id = $1 RETURNING *`,
    [creditId, createdAt],
  );
  return r.rows[0];
};

/**
 * Fuerza a vencido (`expires_at` = ayer) los tokens de blacklist y refresh
 * de un usuario, para el E2E del cron `tokenCleanup` sin esperar el TTL real.
 * @param {object} client Cliente PG dentro de transacción.
 * @param {string} userId Id del usuario cuyos tokens se fuerzan a vencidos.
 * @returns {Promise<{blacklist_rows: number, refresh_token_rows: number}>}
 */
const forceTokensExpired = async (client, userId) => {
  const bl = await client.query(
    `UPDATE token_blacklist SET expires_at = NOW() - INTERVAL '1 day' WHERE user_id = $1`,
    [userId],
  );
  const rt = await client.query(
    `UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 day' WHERE user_id = $1`,
    [userId],
  );
  return { blacklist_rows: bl.rowCount, refresh_token_rows: rt.rowCount };
};

module.exports = {
  findCashSessionIdsByBusinessDay,
  unlinkMovements,
  unlinkCreditDisbursements,
  deleteSessionChildren,
  deleteCashSessions,
  deleteBusinessDay,
  forceInstallmentDueDate,
  deleteCommissionLiquidations,
  forceCreditCreatedAt,
  forceTokensExpired,
};
