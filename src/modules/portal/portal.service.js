const queries = require('./portal.queries');

/**
 * Resumen de cuenta del cliente autenticado.
 * Incluye totales, indicador de estado y próximos vencimientos.
 */
const getAccountSummary = async (customerId) => {
  const { totals, upcoming } = await queries.getAccountSummary(customerId);

  const totalOwed    = totals.total_owed;
  const paidCount    = totals.paid_count;
  const pendingCount = totals.pending_count;
  const overdueCount = totals.overdue_count;

  // Indicador de riesgo: GREEN / YELLOW / RED
  let statusIndicator;
  if (overdueCount === 0)       statusIndicator = 'GREEN';
  else if (overdueCount <= 2)   statusIndicator = 'YELLOW';
  else                          statusIndicator = 'RED';

  return {
    total_owed:       totalOwed,
    paid_count:       paidCount,
    pending_count:    pendingCount,
    overdue_count:    overdueCount,
    status_indicator: statusIndicator,
    upcoming_installments: upcoming,
  };
};

/**
 * Lista de créditos del cliente autenticado.
 */
const getCredits = async (customerId) => {
  return queries.findCredits(customerId);
};

/**
 * Detalle de un crédito con cronograma completo.
 * Valida que el crédito pertenezca al cliente autenticado.
 */
const getCreditById = async (creditId, customerId) => {
  const credit = await queries.findCreditById(creditId, customerId);
  if (!credit) throw { status: 404, message: 'Crédito no encontrado.' };
  return credit;
};

module.exports = { getAccountSummary, getCredits, getCreditById };
