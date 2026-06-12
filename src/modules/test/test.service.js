const bdQueries = require("../businessDays/businessDays.queries");
const queries = require("./test.queries");
const { withTransaction } = require("../../utils/transaction");
const { localDate } = require("../../utils/date");

/**
 * Resetea la jornada de hoy (sucursal default) para tests E2E.
 *
 * Borra `business_days` + `cash_sessions` (y sus dependientes: drops,
 * ingresos manuales, detalle de cierre) de la fecha actual, y desvincula
 * (sin eliminar) los movimientos de negocio que apuntaban a esas cajas
 * (`payments`, `expenses`, `credit_down_payments`, `cash_conversions`,
 * `commission_liquidations`) dejando `cash_session_id = NULL`.
 *
 * Idempotente: si no existe jornada hoy, no hace nada.
 *
 * @returns {Promise<{deleted: boolean, business_day_id?: string, cash_session_ids?: string[], reason?: string}>}
 */
const resetToday = async () =>
  withTransaction(async (client) => {
    const branch = await bdQueries.findDefaultBranch(client);
    if (!branch) return { deleted: false, reason: "NO_DEFAULT_BRANCH" };

    const businessDate = localDate();
    const businessDay = await bdQueries.findByDateAndBranch(
      businessDate,
      branch.id,
      client,
    );
    if (!businessDay)
      return { deleted: false, reason: "NO_BUSINESS_DAY_TODAY" };

    const sessionIds = await queries.findCashSessionIdsByBusinessDay(
      client,
      businessDay.id,
    );

    await queries.unlinkMovements(client, sessionIds);
    await queries.deleteSessionChildren(client, sessionIds);
    await queries.deleteCashSessions(client, businessDay.id);
    await queries.deleteBusinessDay(client, businessDay.id);

    return {
      deleted: true,
      business_day_id: businessDay.id,
      cash_session_ids: sessionIds,
    };
  });

module.exports = { resetToday };
