jest.mock("./expenses.queries", () => ({
  findActiveCategoryById: jest.fn(),
  findRecentDuplicate: jest.fn(),
  create: jest.fn(),
}));

jest.mock("../cashSessions/cashSessions.queries", () => ({
  lockActiveSessionForCurrentJornada: jest.fn(),
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
});
