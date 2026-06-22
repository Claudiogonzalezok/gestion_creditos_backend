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

/**
 * Fuerza el `due_date` de una cuota para tests de mora/cron sin esperar el
 * paso real del tiempo. Resetea `last_penalty_applied_at` para que el cron
 * `overdueInstallments` recalcule la mora desde la nueva fecha.
 * @param {string} installmentId Id de la cuota.
 * @param {string} dueDate Fecha YYYY-MM-DD a forzar.
 * @returns {Promise<object>} Cuota actualizada.
 */
const forceInstallmentDueDate = async (installmentId, dueDate) =>
  withTransaction(async (client) => {
    const installment = await queries.forceInstallmentDueDate(
      client,
      installmentId,
      dueDate,
    );
    if (!installment) {
      const err = new Error("Cuota no encontrada.");
      err.status = 404;
      throw err;
    }
    return installment;
  });

/**
 * Borra todas las liquidaciones de comisiones de un usuario (E2E de
 * liquidación semanal). No toca el status de las comisiones: solo libera el
 * período para que `commissions.liquidate` no choque con el constraint
 * único de "una liquidación por usuario por semana".
 * @param {string} userId
 * @returns {Promise<{deleted_count: number}>}
 */
const resetCommissionLiquidations = async (userId) =>
  withTransaction(async (client) => {
    const deletedCount = await queries.deleteCommissionLiquidations(client, userId);
    return { deleted_count: deletedCount };
  });

/**
 * Fuerza el `created_at` de un crédito para tests del cron `creditExpiry`
 * sin esperar el paso real del tiempo.
 * @param {string} creditId
 * @param {string} createdAt Fecha ISO8601 a forzar.
 * @returns {Promise<object>} Crédito actualizado.
 */
const forceCreditCreatedAt = async (creditId, createdAt) =>
  withTransaction(async (client) => {
    const credit = await queries.forceCreditCreatedAt(client, creditId, createdAt);
    if (!credit) {
      const err = new Error("Crédito no encontrado.");
      err.status = 404;
      throw err;
    }
    return credit;
  });

module.exports = {
  resetToday,
  forceInstallmentDueDate,
  resetCommissionLiquidations,
  forceCreditCreatedAt,
};
