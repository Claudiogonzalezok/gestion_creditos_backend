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

module.exports = {
  findCashSessionIdsByBusinessDay,
  unlinkMovements,
  deleteSessionChildren,
  deleteCashSessions,
  deleteBusinessDay,
};
