// Castigo de crédito (write off) — tests unitarios (queries mockeadas).

jest.mock("../../config/db", () => ({ query: jest.fn() }));
jest.mock("./credits.queries", () => ({
  lockCredit: jest.fn(),
  lockInstallments: jest.fn(),
  hasPendingPayments: jest.fn(),
  writeOffInstallments: jest.fn(),
  writeOffCredit: jest.fn(),
  createWriteOffRecord: jest.fn(),
}));
jest.mock("../../utils/transaction", () => ({ withTransaction: jest.fn() }));

const queries = require("./credits.queries");
const { withTransaction } = require("../../utils/transaction");
const service = require("./credits.service");

const inst = (number, status, amountPaid, amountDue = 20000, id = `i${number}`) => ({
  id,
  installment_number: number,
  status,
  amount_due: amountDue,
  amount_paid: amountPaid,
});

const activeCredit = (overrides = {}) => ({
  id: "credit-1",
  type: "LOAN",
  status: "ACTIVE",
  ...overrides,
});

describe("writeOffCredit — castigo de crédito", () => {
  const client = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    withTransaction.mockImplementation(async (cb) => cb(client));
    queries.hasPendingPayments.mockResolvedValue(false);
    queries.writeOffInstallments.mockResolvedValue();
    queries.writeOffCredit.mockResolvedValue();
    queries.createWriteOffRecord.mockResolvedValue({
      id: "wo-1",
      executed_at: "2026-06-17T00:00:00Z",
    });
  });

  it("castiga: marca cuotas abiertas y crédito, registra el saldo castigado", async () => {
    queries.lockCredit.mockResolvedValue(activeCredit());
    queries.lockInstallments.mockResolvedValue([
      inst(1, "PAID", 20000),
      inst(2, "PAID", 20000),
      inst(3, "PARTIAL", 5000), // remaining 15000
      inst(4, "PENDING", 0), // 20000
      inst(5, "OVERDUE", 0), // 20000
      inst(6, "PENDING", 0), // 20000
    ]);

    const r = await service.writeOffCredit(
      "credit-1",
      { reason: "Incobrable", observations: "Cliente ilocalizable" },
      "admin-1",
    );

    expect(queries.writeOffInstallments).toHaveBeenCalledWith(client, "credit-1");
    expect(queries.writeOffCredit).toHaveBeenCalledWith(client, "credit-1");
    // saldo castigado = 15000 + 20000*3 = 75000
    expect(queries.createWriteOffRecord).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        credit_id: "credit-1",
        written_off_balance: 75000,
        reason: "Incobrable",
        observations: "Cliente ilocalizable",
        executed_by: "admin-1",
      }),
    );
    expect(r).toMatchObject({ written_off_balance: 75000, write_off_id: "wo-1" });
  });

  it("rechaza crédito no ACTIVE → 409 y no muta", async () => {
    queries.lockCredit.mockResolvedValue(activeCredit({ status: "SETTLED" }));
    await expect(
      service.writeOffCredit("credit-1", { reason: "x" }, "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(queries.writeOffCredit).not.toHaveBeenCalled();
  });

  it("404 si el crédito no existe", async () => {
    queries.lockCredit.mockResolvedValue(null);
    await expect(
      service.writeOffCredit("x", { reason: "x" }, "admin-1"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rechaza si no hay cuotas abiertas (sin saldo) → 409", async () => {
    queries.lockCredit.mockResolvedValue(activeCredit());
    queries.lockInstallments.mockResolvedValue([
      inst(1, "PAID", 20000),
      inst(2, "PAID", 20000),
    ]);
    await expect(
      service.writeOffCredit("credit-1", { reason: "x" }, "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(queries.writeOffCredit).not.toHaveBeenCalled();
  });

  it("rechaza si hay cobros PENDING → 409 y no muta", async () => {
    queries.lockCredit.mockResolvedValue(activeCredit());
    queries.hasPendingPayments.mockResolvedValue(true);
    await expect(
      service.writeOffCredit("credit-1", { reason: "x" }, "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(queries.lockInstallments).not.toHaveBeenCalled();
    expect(queries.writeOffCredit).not.toHaveBeenCalled();
  });
});
