const queries = require("./expenses.queries");
const cashSessionsQueries = require("../cashSessions/cashSessions.queries");
const {
  computeAvailableCash,
} = require("../cashSessions/cashSessions.calculations");
const cashAccountsQueries = require("../cashAccounts/cashAccounts.queries");
const cashAccountsService = require("../cashAccounts/cashAccounts.service");
const {
  getActiveJornadaDate,
} = require("../businessDays/businessDays.service");

const getAll = async ({ dateFrom, dateTo, categoryId, page, limit } = {}) => {
  return queries.findAll({ dateFrom, dateTo, categoryId, page, limit });
};

const getById = async (id) => {
  const expense = await queries.findById(id);
  if (!expense) throw { status: 404, message: "Gasto no encontrado." };
  return expense;
};

const create = async (data, requestingUser) => {
  if (data.category_id) {
    const category = await queries.findActiveCategoryById(data.category_id);
    if (!category)
      throw {
        status: 422,
        message: "La categoría seleccionada no existe o está inactiva.",
      };
  }

  const source = data.source || "DAILY";
  const registerDate = await getActiveJornadaDate();

  const { withTransaction } = require("../../utils/transaction");
  return withTransaction(async (client) => {
    const duplicate = await queries.findRecentDuplicate(
      {
        amount: parseFloat(data.amount),
        categoryId: data.category_id || null,
        expenseDate: data.expense_date,
        createdBy: requestingUser.id,
      },
      client,
    );
    if (duplicate)
      throw {
        status: 409,
        message:
          "Ya existe un gasto idéntico registrado en los últimos 30 segundos. Verificá antes de reintentar.",
      };

    // COMPANY: el gasto sale de Caja General, sin pasar por la caja operativa.
    // insertMovementWithBalance valida current_balance >= 0 (409 INSUFFICIENT_BALANCE).
    if (source === "COMPANY") {
      const account = await cashAccountsQueries.findGeneralCashAccount(client);
      if (!account)
        throw {
          status: 409,
          message: "No existe una Caja General activa.",
          code: "NO_GENERAL_CASH_ACCOUNT",
        };

      const expense = await queries.create(
        {
          amount: parseFloat(data.amount),
          description: data.description,
          expenseDate: data.expense_date,
          paymentMethod: data.payment_method,
          transferReference: data.transfer_reference || null,
          categoryId: data.category_id || null,
          createdBy: requestingUser.id,
          registerDate,
          cashSessionId: null,
          source,
        },
        client,
      );

      await cashAccountsService.insertMovementWithBalance(client, {
        cashAccountId: account.id,
        movementType: "EXPENSE",
        direction: "OUT",
        amount: parseFloat(data.amount),
        description: data.description,
        referenceType: "EXPENSE",
        referenceId: expense.id,
        createdBy: requestingUser.id,
      });

      return expense;
    }

    // DAILY (default): V4.3, imputar a la caja activa de la jornada.
    const activeSession =
      await cashSessionsQueries.lockActiveSessionForCurrentJornada(client);
    if (!activeSession)
      throw {
        status: 409,
        message:
          "No hay caja operativa abierta. Abrí una caja para registrar gastos.",
        code: "NO_ACTIVE_SESSION",
      };

    if (data.payment_method === "CASH") {
      const totals = await cashSessionsQueries.computeSessionTotals(
        activeSession.id,
        client,
      );
      const availableCash = computeAvailableCash(activeSession, totals);
      if (parseFloat(data.amount) > availableCash) {
        throw {
          status: 409,
          message: `El monto supera el efectivo disponible en caja ($${availableCash.toFixed(2)}).`,
          code: "INSUFFICIENT_CASH",
        };
      }
    }

    return queries.create(
      {
        amount: parseFloat(data.amount),
        description: data.description,
        expenseDate: data.expense_date,
        paymentMethod: data.payment_method,
        transferReference: data.transfer_reference || null,
        categoryId: data.category_id || null,
        createdBy: requestingUser.id,
        registerDate,
        cashSessionId: activeSession.id,
        source,
      },
      client,
    );
  });
};

/**
 * IMP-7: un gasto queda inmutable cuando su caja contable (cash_session) está
 * CLOSED — fuente de verdad post-Fase 2/3. El check legacy sobre
 * cash_registers aplica SOLO a gastos DAILY pre-Fase 2 sin cash_session_id:
 * un gasto COMPANY nunca pasó por la caja operativa (sale de Caja General), y
 * un gasto con cash_session_id ya queda cubierto por el estado de su sesión.
 */
const assertExpenseMutable = async (expense) => {
  if (expense.cash_session_id && expense.cash_session_status === "CLOSED")
    throw {
      status: 409,
      message: "No se puede modificar un gasto cuya caja ya fue cerrada.",
    };
  if (expense.cash_session_id || expense.source === "COMPANY") return;
  const closedLegacy = await queries.hasCashRegister(
    expense.expense_date || expense.created_at,
  );
  if (closedLegacy)
    throw {
      status: 409,
      message:
        "No se puede modificar un gasto que ya fue incluido en un cierre de caja.",
    };
};

/**
 * Issue #50: compensa en la Caja General la diferencia de monto de un gasto
 * COMPANY con un movimiento ADJUSTMENT (OUT si aumenta, IN si disminuye).
 * insertMovementWithBalance bloquea la cuenta y rechaza saldo negativo (409).
 * @param {object} client - client transaccional
 * @param {{ expense: object, delta: number, description: string, userId: string }} params
 *   expense: gasto original bloqueado; delta: nuevo monto menos monto original.
 */
const adjustCompanyLedger = async (
  client,
  { expense, delta, description, userId },
) => {
  const amount = Number(Math.abs(delta).toFixed(2));
  if (expense.source !== "COMPANY" || amount === 0) return;

  const accountId =
    (await queries.findCompanyExpenseAccountId(expense.id, client)) ||
    (await cashAccountsQueries.findGeneralCashAccount(client))?.id;
  if (!accountId)
    throw {
      status: 409,
      message: "No existe una Caja General activa.",
      code: "NO_GENERAL_CASH_ACCOUNT",
    };

  await cashAccountsService.insertMovementWithBalance(client, {
    cashAccountId: accountId,
    movementType: "ADJUSTMENT",
    direction: delta > 0 ? "OUT" : "IN",
    amount,
    description,
    referenceType: "EXPENSE",
    referenceId: expense.id,
    createdBy: userId,
  });
};

/**
 * Actualiza un gasto validando que no pertenezca a una caja ya cerrada.
 * Si es COMPANY, ajusta el saldo de la Caja General en la misma transacción.
 * @param {string} id
 * @param {{ amount: number|string, description: string, expense_date?: string, payment_method: 'CASH'|'TRANSFER', transfer_reference?: string|null, category_id?: string|null }} data
 * @param {{ id: string }} requestingUser
 * @returns {Promise<object>}
 */
const update = async (id, data, requestingUser) => {
  if (data.category_id) {
    const category = await queries.findActiveCategoryById(data.category_id);
    if (!category)
      throw {
        status: 422,
        message: "La categoría seleccionada no existe o está inactiva.",
      };
  }

  const { withTransaction } = require("../../utils/transaction");
  return withTransaction(async (client) => {
    const expense = await queries.findById(id, client, { forUpdate: true });
    if (!expense) throw { status: 404, message: "Gasto no encontrado." };

    await assertExpenseMutable(expense);

    const amount = parseFloat(data.amount);
    await adjustCompanyLedger(client, {
      expense,
      delta: amount - expense.amount,
      description: `Ajuste por edición de gasto: ${data.description}`,
      userId: requestingUser.id,
    });

    return queries.update(
      {
        id,
        amount,
        description: data.description,
        expenseDate: data.expense_date,
        paymentMethod: data.payment_method,
        transferReference: data.transfer_reference || null,
        categoryId: data.category_id || null,
      },
      client,
    );
  });
};

/**
 * Elimina un gasto. Si es COMPANY, devuelve su monto a la Caja General en la
 * misma transacción.
 * @param {string} id
 * @param {{ id: string }} requestingUser
 */
const remove = async (id, requestingUser) => {
  const { withTransaction } = require("../../utils/transaction");
  await withTransaction(async (client) => {
    const expense = await queries.findById(id, client, { forUpdate: true });
    if (!expense) throw { status: 404, message: "Gasto no encontrado." };

    await assertExpenseMutable(expense);

    await adjustCompanyLedger(client, {
      expense,
      delta: -expense.amount,
      description: `Ajuste por eliminación de gasto: ${expense.description}`,
      userId: requestingUser.id,
    });

    await queries.remove(id, client);
  });
};

module.exports = { getAll, getById, create, update, remove };
