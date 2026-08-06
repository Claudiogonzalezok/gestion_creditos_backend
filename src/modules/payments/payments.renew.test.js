// Renovación de préstamo LOAN de una sola cuota (payments.service.renew).
// Verifica: interés = amount_due − total_amount, pago etiquetado RENEWAL, impacto
// en caja, corrimiento de vencimiento, y que NO se aplica el pago a la cuota.

jest.mock("../../config/db", () => ({ query: jest.fn() }));

jest.mock("./payments.queries", () => ({
  getRenewableLoan: jest.fn(),
  lockAndGetInstallment: jest.fn(),
  createApproved: jest.fn(),
  renewInstallment: jest.fn(),
  updateInstallment: jest.fn(), // no debe llamarse en una renovación
  findById: jest.fn(),
}));

jest.mock("./cash_movements.queries", () => ({ create: jest.fn() }));

jest.mock("../businessDays/businessDays.service", () => ({
  getActiveJornadaDate: jest.fn().mockResolvedValue("2026-09-05"),
}));

jest.mock("../businessDays/businessDays.queries", () => ({
  // findDefaultBranch → null hace que _validateCajaOpen no valide nada (rama corta).
  findDefaultBranch: jest.fn().mockResolvedValue(null),
  isJornadaMutable: jest.fn(),
}));

jest.mock("../cashSessions/cashSessions.queries", () => ({
  lockActiveSessionForCurrentJornada: jest.fn(),
}));

jest.mock("../collections/collections.queries", () => ({
  updateManagementStatusForActiveTodaySheet: jest.fn(),
}));

jest.mock("../collectionAttempts/collectionAttempts.queries", () => ({
  voidScheduledVisitsForInstallment: jest.fn(),
}));

jest.mock("../systemConfig/systemConfig.queries", () => ({
  getValue: jest.fn().mockResolvedValue("3"),
}));

jest.mock("../../utils/transaction", () => ({ withTransaction: jest.fn() }));

const queries = require("./payments.queries");
const cashMovementsQueries = require("./cash_movements.queries");
const collectionAttemptsQueries = require("../collectionAttempts/collectionAttempts.queries");
const cashSessionsQueries = require("../cashSessions/cashSessions.queries");
const { withTransaction } = require("../../utils/transaction");
const service = require("./payments.service");

const CREDIT_ID = "credit-1";

/** Préstamo LOAN de 1 cuota: capital 10.000, cuota 12.000 (interés 2.000). */
const validLoan = (overrides = {}) => ({
  type: "LOAN",
  installments_count: 1,
  credit_status: "ACTIVE",
  total_amount: 10000,
  payment_frequency: "MONTHLY",
  installment_id: "inst-1",
  amount_due: 12000,
  penalty_amount: 0,
  installment_status: "PENDING",
  due_date: "2026-09-05",
  ...overrides,
});

describe("payments.service.renew — renovación de préstamo de una sola cuota", () => {
  const client = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    withTransaction.mockImplementation(async (cb) => cb(client));
    cashSessionsQueries.lockActiveSessionForCurrentJornada.mockResolvedValue({
      id: "sess-1",
    });
    queries.lockAndGetInstallment.mockResolvedValue({
      id: "inst-1",
      status: "PENDING",
    });
    queries.createApproved.mockResolvedValue({ id: "pay-1" });
    queries.renewInstallment.mockResolvedValue();
    queries.findById.mockResolvedValue({ id: "pay-1" });
  });

  it("registra el interés (amount_due − capital) como pago RENEWAL e impacta caja", async () => {
    queries.getRenewableLoan.mockResolvedValue(validLoan());

    await service.renew(CREDIT_ID, { payment_method: "CASH" }, "admin-1");

    expect(queries.createApproved).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        installmentId: "inst-1",
        amountReceived: 2000,
        amountCash: 2000,
        amountTransfer: 0,
        paymentMethod: "CASH",
        notes: "Pago por renovación",
        generationType: "RENEWAL",
        cashSessionId: "sess-1",
      }),
    );
    // Impacta caja como cualquier cobro.
    expect(cashMovementsQueries.create).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ amount: 2000, paymentMethod: "CASH", movementType: "PAYMENT" }),
    );
  });

  it("corre el vencimiento un período y NO aplica el pago a la cuota", async () => {
    queries.getRenewableLoan.mockResolvedValue(validLoan());

    await service.renew(CREDIT_ID, { payment_method: "CASH" }, "admin-1");

    expect(queries.renewInstallment).toHaveBeenCalledWith(
      client,
      "inst-1",
      "MONTHLY",
      3,
    );
    // El capital sigue debiéndose: nunca se toca el saldo de la cuota.
    expect(queries.updateInstallment).not.toHaveBeenCalled();
    // La próxima visita se resetea (se anulan las gestiones agendadas de la cuota).
    expect(
      collectionAttemptsQueries.voidScheduledVisitsForInstallment,
    ).toHaveBeenCalledWith(client, "inst-1", "admin-1");
  });

  it("cobra interés + mora cuando la cuota tiene mora manual aplicada", async () => {
    // Interés 2.000 + mora 500 = 2.500 a cobrar.
    queries.getRenewableLoan.mockResolvedValue(validLoan({ penalty_amount: 500 }));

    await service.renew(CREDIT_ID, { payment_method: "CASH" }, "admin-1");

    expect(queries.createApproved).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        amountReceived: 2500,
        amountCash: 2500,
        generationType: "RENEWAL",
      }),
    );
  });

  it("acepta pago mixto cuando efectivo + transferencia suman el total (interés + mora)", async () => {
    queries.getRenewableLoan.mockResolvedValue(validLoan());

    await service.renew(
      CREDIT_ID,
      { payment_method: "MIXED", amount_cash: 1500, amount_transfer: 500 },
      "admin-1",
    );

    expect(queries.createApproved).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        amountReceived: 2000,
        amountCash: 1500,
        amountTransfer: 500,
        paymentMethod: "MIXED",
        generationType: "RENEWAL",
      }),
    );
  });

  it("rechaza 422 si el mixto no suma exactamente el interés", async () => {
    queries.getRenewableLoan.mockResolvedValue(validLoan());

    await expect(
      service.renew(
        CREDIT_ID,
        { payment_method: "MIXED", amount_cash: 1000, amount_transfer: 500 },
        "admin-1",
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(queries.createApproved).not.toHaveBeenCalled();
  });

  it("rechaza 409 si no es un préstamo de una sola cuota", async () => {
    queries.getRenewableLoan.mockResolvedValue(validLoan({ installments_count: 3 }));

    await expect(
      service.renew(CREDIT_ID, { payment_method: "CASH" }, "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rechaza 409 si el crédito no está ACTIVE", async () => {
    queries.getRenewableLoan.mockResolvedValue(validLoan({ credit_status: "SETTLED" }));

    await expect(
      service.renew(CREDIT_ID, { payment_method: "CASH" }, "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rechaza 409 si la cuota ya está pagada", async () => {
    queries.getRenewableLoan.mockResolvedValue(validLoan({ installment_status: "PAID" }));

    await expect(
      service.renew(CREDIT_ID, { payment_method: "CASH" }, "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rechaza 404 si el crédito no existe", async () => {
    queries.getRenewableLoan.mockResolvedValue(null);

    await expect(
      service.renew(CREDIT_ID, { payment_method: "CASH" }, "admin-1"),
    ).rejects.toMatchObject({ status: 404 });
  });
});
