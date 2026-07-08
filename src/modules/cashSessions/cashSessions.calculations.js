// Cálculos puros sobre totales de caja — sin dependencias de DB ni de otros
// módulos. Separado de cashSessions.service.js a propósito: otros services
// (expenses, credits) necesitan esta fórmula sin arrastrar todo el grafo de
// requires de cashSessions.service (payments.service, businessDays.queries,
// etc.), que complica los mocks en tests unitarios.

/**
 * Efectivo disponible en la caja activa en este instante (antes de imputar una
 * nueva operación). Misma fórmula que `expectedCash` en `buildClosureSnapshot`,
 * pero a partir de los totales acumulados hasta el momento. Se usa para
 * validar gastos y desembolsos de préstamo antes de aprobarlos.
 * @param {object} session - Sesión activa (incluye opening_amount).
 * @param {object} totals - Resultado de computeSessionTotals.
 * @returns {number} Efectivo disponible.
 */
const computeAvailableCash = (session, totals) =>
  session.opening_amount +
  totals.collections_payments_cash +
  totals.collections_down_payments_cash +
  totals.collections_manual_incomes_cash -
  totals.outflows_expenses_cash -
  totals.outflows_commissions_cash -
  totals.outflows_loans_cash +
  totals.conversions_cash_delta -
  totals.drops_cash;

module.exports = { computeAvailableCash };
