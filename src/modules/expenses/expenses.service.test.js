jest.mock("./expenses.queries", () => ({
  findActiveCategoryById: jest.fn(),
  findRecentDuplicate: jest.fn(),
  create: jest.fn(),
  findById: jest.fn(),
  findCompanyExpenseAccountId: jest.fn(),
  hasCashRegister: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
}));

jest.mock("../cashSessions/cashSessions.queries", () => ({
  lockActiveSessionForCurrentJornada: jest.fn(),
  computeSessionTotals: jest.fn(),
}));

jest.mock("../cashAccounts/cashAccounts.queries", () => ({
  findGeneralCashAccount: jest.fn(),
}));

jest.mock("../cashAccounts/cashAccounts.service", () => ({
  insertMovementWithBalance: jest.fn(),
}));

jest.mock("../businessDays/businessDays.service", () => ({
  getActiveJornadaDate: jest.fn(),
}));

jest.mock("../../utils/transaction", () => ({
  withTransaction: jest.fn(),
}));

const queries = require("./expenses.queries");
const cashSessionsQueries = require("../cashSessions/cashSessions.queries");
const {
  getActiveJornadaDate,
} = require("../businessDays/businessDays.service");
const { withTransaction } = require("../../utils/transaction");
const cashAccountsQueries = require("../cashAccounts/cashAccounts.queries");
const cashAccountsService = require("../cashAccounts/cashAccounts.service");
const service = require("./expenses.service");

describe("expenses.service", () => {
  const client = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    withTransaction.mockImplementation(async (callback) => callback(client));
    getActiveJornadaDate.mockResolvedValue("2026-04-23");
    queries.findActiveCategoryById.mockResolvedValue({ id: "cat-1" });
    queries.findRecentDuplicate.mockResolvedValue(null);
    cashSessionsQueries.lockActiveSessionForCurrentJornada.mockResolvedValue({
      id: "cash-session-1",
      opening_amount: 5000,
    });
    cashSessionsQueries.computeSessionTotals.mockResolvedValue({
      collections_payments_cash: 0,
      collections_down_payments_cash: 0,
      collections_manual_incomes_cash: 0,
      outflows_expenses_cash: 0,
      outflows_commissions_cash: 0,
      conversions_cash_delta: 0,
      drops_cash: 0,
    });
    queries.create.mockResolvedValue({ id: "expense-1" });
  });

  it("imputa el gasto a la jornada activa aunque el día calendario sea otro — CA-05", async () => {
    await service.create(
      {
        amount: 1337,
        description: "Gasto post medianoche",
        expense_date: "2026-04-24",
        payment_method: "CASH",
        category_id: "cat-1",
      },
      { id: "admin-1" },
    );

    expect(queries.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1337,
        expenseDate: "2026-04-24",
        paymentMethod: "CASH",
        categoryId: "cat-1",
        createdBy: "admin-1",
        registerDate: "2026-04-23",
        cashSessionId: "cash-session-1",
      }),
      client,
    );
  });

  describe("update/remove — issue #50", () => {
    const user = { id: "admin-1" };
    const data = { amount: 350, description: "proveedor", payment_method: "TRANSFER" };

    it("COMPANY: edita con ADJUSTMENT OUT por la diferencia sobre la cuenta original", async () => {
      queries.findById.mockResolvedValue({ id: "e1", amount: 200, source: "COMPANY" });
      queries.findCompanyExpenseAccountId.mockResolvedValue("acc-1");
      queries.update.mockResolvedValue({ id: "e1", amount: 350 });

      await service.update("e1", data, user);

      expect(queries.findById).toHaveBeenCalledWith("e1", client, { forUpdate: true });
      expect(queries.hasCashRegister).not.toHaveBeenCalled();
      expect(cashAccountsService.insertMovementWithBalance).toHaveBeenCalledWith(
        client,
        expect.objectContaining({
          cashAccountId: "acc-1", movementType: "ADJUSTMENT", direction: "OUT",
          amount: 150, referenceType: "EXPENSE", referenceId: "e1", createdBy: "admin-1",
        }),
      );
      expect(queries.update).toHaveBeenCalledWith(expect.objectContaining({ amount: 350 }), client);
    });

    it("COMPANY sin movimiento original: usa la Caja General; sin ella responde 409", async () => {
      queries.findById.mockResolvedValue({ id: "e1", amount: 200, source: "COMPANY" });
      queries.findCompanyExpenseAccountId.mockResolvedValue(null);
      cashAccountsQueries.findGeneralCashAccount.mockResolvedValueOnce({ id: "gen" });

      await service.remove("e1", user);
      expect(cashAccountsService.insertMovementWithBalance).toHaveBeenCalledWith(
        client,
        expect.objectContaining({ cashAccountId: "gen", direction: "IN", amount: 200 }),
      );
      expect(queries.remove).toHaveBeenCalledWith("e1", client);

      cashAccountsQueries.findGeneralCashAccount.mockResolvedValueOnce(null);
      await expect(service.remove("e1", user)).rejects.toMatchObject({
        status: 409, code: "NO_GENERAL_CASH_ACCOUNT",
      });
    });

    it("DAILY legacy sin caja: aplica el chequeo de cash_registers y no toca Caja General", async () => {
      queries.findById.mockResolvedValue({ id: "e2", amount: 100, source: "DAILY", expense_date: "2026-01-01" });
      queries.hasCashRegister.mockResolvedValue(true);

      await expect(service.update("e2", data, user)).rejects.toMatchObject({ status: 409 });
      expect(cashAccountsService.insertMovementWithBalance).not.toHaveBeenCalled();
    });

    it("inexistente responde 404", async () => {
      queries.findById.mockResolvedValue(null);
      await expect(service.remove("nope", user)).rejects.toMatchObject({ status: 404 });
    });
  });
});
