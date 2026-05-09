const queries = require('./portal.queries');

/**
 * Resumen de cuenta del cliente autenticado.
 * Incluye totales, indicador de estado, próximos vencimientos y resumen de créditos.
 */
const getAccountSummary = async (customerId) => {
  const { totals, upcoming, creditsSummary } = await queries.getAccountSummary(customerId);

  const totalOwed    = parseFloat(totals.total_owed);
  const paidCount    = parseInt(totals.paid_count);
  const pendingCount = parseInt(totals.pending_count);
  const overdueCount = parseInt(totals.overdue_count);

  // Indicador de riesgo: GREEN / YELLOW / RED
  let statusIndicator;
  if (overdueCount === 0)     statusIndicator = 'GREEN';
  else if (overdueCount <= 2) statusIndicator = 'YELLOW';
  else                        statusIndicator = 'RED';

  return {
    total_owed:               totalOwed,
    paid_count:               paidCount,
    pending_count:            pendingCount,
    overdue_count:            overdueCount,
    status_indicator:         statusIndicator,
    total_paid_amount:        parseFloat(totals.total_paid_amount),
    pending_penalty_amount:   parseFloat(totals.pending_penalty_amount),
    active_credits:           parseInt(creditsSummary.active_credits),
    settled_credits:          parseInt(creditsSummary.settled_credits),
    total_installments_count: parseInt(creditsSummary.total_installments_count),
    upcoming_installments:    upcoming.map(u => ({
      id:                         u.id,
      installment_number:         u.installment_number,
      due_date:                   u.due_date,
      amount_due:                 parseFloat(u.amount_due),
      amount_paid:                parseFloat(u.amount_paid),
      penalty_amount:             parseFloat(u.penalty_amount),
      status:                     u.status,
      credit_id:                  u.credit_id,
      credit_type:                u.credit_type,
      credit_installments_count:  parseInt(u.credit_installments_count),
      credit_name:                u.credit_name ?? null,
    })),
  };
};

/**
 * Lista de créditos del cliente autenticado.
 */
const getCredits = async (customerId) => {
  const rows = await queries.findCredits(customerId);
  return rows.map(r => ({
    id:                 r.id,
    type:               r.type,
    credit_name:        r.credit_name ?? null,
    total_amount:       parseFloat(r.total_amount),
    total_to_return:    parseFloat(r.total_to_return),
    installments_count: parseInt(r.installments_count),
    installment_amount: r.installment_amount != null ? parseFloat(r.installment_amount) : null,
    payment_frequency:  r.payment_frequency,
    status:             r.status,
    created_at:         r.created_at,
    approved_at:        r.approved_at ?? null,
    settled_at:         r.settled_at ?? null,
    total_installments: parseInt(r.total_installments),
    paid_installments:  parseInt(r.paid_installments),
    next_due_date:      r.next_due_date ?? null,
    next_due_amount:    r.next_due_amount != null ? parseFloat(r.next_due_amount) : null,
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

  return {
    id:                   credit.id,
    type:                 credit.type,
    credit_name:          credit.credit_name ?? null,
    total_amount:         parseFloat(credit.total_amount),
    total_to_return:      totalToReturn,
    installments_count:   parseInt(credit.installments_count),
    payment_frequency:    credit.payment_frequency,
    status:               credit.status,
    created_at:           credit.created_at,
    approved_at:          credit.approved_at ?? null,
    settled_at:           credit.settled_at ?? null,
    down_payment:         parseFloat(credit.down_payment),
    down_payment_method:  credit.down_payment_method ?? null,
    prepaid_installments: parseInt(credit.prepaid_installments),
    interest_rate:        credit.interest_rate != null ? parseFloat(credit.interest_rate) : null,
    installments:         credit.installments.map(i => ({
      id:                 i.id,
      installment_number: i.installment_number,
      due_date:           i.due_date,
      amount_due:         parseFloat(i.amount_due),
      amount_paid:        parseFloat(i.amount_paid),
      penalty_amount:     parseFloat(i.penalty_amount),
      status:             i.status,
    })),
  };
};

module.exports = { getAccountSummary, getCredits, getCreditById };
