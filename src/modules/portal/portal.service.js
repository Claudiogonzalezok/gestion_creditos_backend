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
    total_owed:            totalOwed,
    paid_count:            paidCount,
    pending_count:         pendingCount,
    overdue_count:         overdueCount,
    status_indicator:      statusIndicator,
    total_paid_amount:     parseFloat(totals.total_paid_amount),
    pending_penalty_amount: parseFloat(totals.pending_penalty_amount),
    upcoming_installments: upcoming,
  };
};

/**
 * Lista de créditos del cliente autenticado.
 */
const getCredits = async (customerId) => {
  const rows = await queries.findCredits(customerId);
  return rows.map(r => ({
    ...r,
    total_amount:       parseFloat(r.total_amount),
    total_to_return:    parseFloat(r.total_to_return),
    total_installments: parseInt(r.total_installments),
    paid_installments:  parseInt(r.paid_installments),
    pending_penalty:    parseFloat(r.pending_penalty),
    has_overdue:        r.has_overdue === true,
  }));
};

/**
 * Detalle de un crédito con cronograma completo.
 * Valida que el crédito pertenezca al cliente autenticado.
 */
const getCreditById = async (creditId, customerId) => {
  const credit = await queries.findCreditById(creditId, customerId);
  if (!credit) throw { status: 404, message: 'Crédito no encontrado.' };

  const totalToReturn = credit.installments.reduce(
    (sum, i) => sum + parseFloat(i.amount_due),
    0,
  );

  return { ...credit, total_to_return: totalToReturn };
};

module.exports = { getAccountSummary, getCredits, getCreditById };
