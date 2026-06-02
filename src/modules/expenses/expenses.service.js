const queries = require('./expenses.queries');
const cashSessionsQueries = require('../cashSessions/cashSessions.queries');
const businessDaysQueries = require('../businessDays/businessDays.queries');
const { localDate } = require('../../utils/date');

/**
 * IMP-1: consulta business_days (autoridad post-rediseño). Cae al día actual
 * si no hay jornada abierta.
 */
const getActiveJornadaDate = async () => {
  const branch = await businessDaysQueries.findDefaultBranch();
  if (!branch) return localDate();
  const jornadaDate = await businessDaysQueries.findActiveJornadaDate(branch.id);
  return jornadaDate || localDate();
};

const getAll = async ({ dateFrom, dateTo, categoryId, page, limit } = {}) => {
  return queries.findAll({ dateFrom, dateTo, categoryId, page, limit });
};

const getById = async (id) => {
  const expense = await queries.findById(id);
  if (!expense) throw { status: 404, message: 'Gasto no encontrado.' };
  return expense;
};

const create = async (data, requestingUser) => {
  if (data.category_id) {
    const category = await queries.findActiveCategoryById(data.category_id);
    if (!category) throw { status: 422, message: 'La categoría seleccionada no existe o está inactiva.' };
  }
  // Pre-check amistoso + re-validación bajo lock en la tx (IMP-2).
  const sessionPreCheck = await cashSessionsQueries.findOpenByOwner(requestingUser.id);
  if (!sessionPreCheck)
    throw { status: 409, message: 'Tenés que abrir una caja antes de registrar un gasto.' };

  const registerDate = await getActiveJornadaDate();

  const { withTransaction } = require('../../utils/transaction');
  return withTransaction(async (client) => {
    const session = await cashSessionsQueries.lockOpenSessionForUser(client, requestingUser.id);
    if (!session)
      throw { status: 409, message: 'Tenés que abrir una caja antes de registrar un gasto.' };

    return queries.create({
      amount:            parseFloat(data.amount),
      description:       data.description,
      expenseDate:       data.expense_date,
      paymentMethod:     data.payment_method,
      transferReference: data.transfer_reference || null,
      categoryId:        data.category_id || null,
      createdBy:         requestingUser.id,
      registerDate,
      cashSessionId:     session.id,
    }, client);
  });
};

/**
 * Actualiza un gasto validando que no pertenezca a una caja ya cerrada.
 * @param {string} id
 * @param {{ amount: number|string, description: string, expense_date?: string, payment_method: 'CASH'|'TRANSFER', transfer_reference?: string|null, category_id?: string|null }} data
 * @returns {Promise<object>}
 */
/**
 * IMP-7: un gasto queda inmutable cuando su caja contable (cash_session) está
 * CLOSED — fuente de verdad post-Fase 2/3. Se mantiene además el check legacy
 * sobre cash_registers para gastos pre-Fase 2 que pudieran no tener
 * cash_session_id asociado.
 */
const assertExpenseMutable = async (expense) => {
  if (expense.cash_session_id && expense.cash_session_status === 'CLOSED')
    throw { status: 409, message: 'No se puede modificar un gasto cuya caja ya fue cerrada.' };
  const closedLegacy = await queries.hasCashRegister(expense.expense_date || expense.created_at);
  if (closedLegacy)
    throw { status: 409, message: 'No se puede modificar un gasto que ya fue incluido en un cierre de caja.' };
};

const update = async (id, data) => {
  const expense = await queries.findById(id);
  if (!expense) throw { status: 404, message: 'Gasto no encontrado.' };

  await assertExpenseMutable(expense);

  if (data.category_id) {
    const category = await queries.findActiveCategoryById(data.category_id);
    if (!category) throw { status: 422, message: 'La categoría seleccionada no existe o está inactiva.' };
  }

  return queries.update({
    id,
    amount: parseFloat(data.amount),
    description: data.description,
    expenseDate: data.expense_date,
    paymentMethod: data.payment_method,
    transferReference: data.transfer_reference || null,
    categoryId: data.category_id || null,
  });
};

const remove = async (id) => {
  const expense = await queries.findById(id);
  if (!expense) throw { status: 404, message: 'Gasto no encontrado.' };

  await assertExpenseMutable(expense);

  await queries.remove(id);
};

module.exports = { getAll, getById, create, update, remove };
