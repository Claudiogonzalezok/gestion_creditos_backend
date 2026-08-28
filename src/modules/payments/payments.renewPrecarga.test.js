// Camino PRE-CARGA de la renovación (misma operación de negocio RENEWAL, por el
// pipeline de pre-carga). Verifica:
//   · create con generation_type=RENEWAL → nace PENDING, monto = interés + mora,
//     NO toca la cuota (no corre vencimiento hasta aprobar), guarda anti-duplicado.
//   · approve de un pago RENEWAL → marca APPROVED, corre los efectos de renovación
//     e impacta caja, SIN aplicar el pago a la cuota ni liquidar el crédito.

jest.mock("../../config/db", () => ({ query: jest.fn() }));

jest.mock("./payments.queries", () => ({
  getRenewableLoan: jest.fn(),
  getPendingCommittedAmount: jest.fn(),
  create: jest.fn(),
  lockAndGetPayment: jest.fn(),
  approve: jest.fn(),
  lockAndGetInstallment: jest.fn(),
  renewInstallment: jest.fn(),
  updateInstallment: jest.fn(), // no debe llamarse en una renovación
  settleCredit: jest.fn(), // una renovación nunca liquida el crédito
  countPendingInstallments: jest.fn(),
  findById: jest.fn(),
}));

jest.mock("./cash_movements.queries", () => ({ create: jest.fn() }));

jest.mock("../businessDays/businessDays.service", () => ({
  getActiveJornadaDate: jest.fn().mockResolvedValue("2026-09-05"),
}));

jest.mock("../businessDays/businessDays.queries", () => ({
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

jest.mock("../notifications/notifications.service", () => ({ notify: jest.fn() }));
jest.mock("../notifications/notifications.queries", () => ({
  getActiveAdminUserIds: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../utils/transaction", () => ({ withTransaction: jest.fn() }));

const pool = require("../../config/db");
const queries = require("./payments.queries");
const cashMovementsQueries = require("./cash_movements.queries");
const collectionAttemptsQueries = require("../collectionAttempts/collectionAttempts.queries");
const cashSessionsQueries = require("../cashSessions/cashSessions.queries");
const { withTransaction } = require("../../utils/transaction");
const service = require("./payments.service");

/** Préstamo LOAN de 1 cuota: capital 10.000, congelado 12.000 (interés 2.000). */
const validLoan = (overrides = {}) => ({
  type: "LOAN",
  installments_count: 1,
  credit_status: "ACTIVE",
  total_amount: 10000,
  payment_frequency: "MONTHLY",
  installment_id: "inst-1",
  original_amount: 12000,
  amount_due: 12000,
  penalty_amount: 0,
  installment_status: "PENDING",
  due_date: "2026-09-05",
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
describe("payments.service.create — PRE-CARGA de renovación (RENEWAL)", () => {
  const ADMIN = { id: "admin-1" };

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [{ credit_id: "credit-1" }] });
    queries.getRenewableLoan.mockResolvedValue(validLoan());
    queries.getPendingCommittedAmount.mockResolvedValue(0);
    queries.create.mockResolvedValue({
      id: "pay-1",
      status: "PENDING",
      generation_type: "RENEWAL",
    });
  });

  it("nace PENDING con generation_type=RENEWAL, monto interés+mora y SIN tocar la cuota", async () => {
    queries.getRenewableLoan.mockResolvedValue(
      validLoan({ penalty_amount: 500, amount_due: 12500 }),
    );

    const res = await service.create(
      {
        installment_id: "inst-1",
        generation_type: "RENEWAL",
        payment_method: "CASH",
        amount_received: 2500, // interés 2.000 + mora 500
      },
      ADMIN,
    );

    expect(queries.create).toHaveBeenCalledWith(
      expect.objectContaining({
        installment_id: "inst-1",
        amount_received: 2500,
        payment_method: "CASH",
        generation_type: "RENEWAL",
        cash_session_id: null,
        notes: "Pago por renovación",
      }),
    );
    // La pre-carga NO corre el vencimiento: los efectos van en approve.
    expect(queries.renewInstallment).not.toHaveBeenCalled();
    expect(res.status).toBe("PENDING");
  });

  it("acepta mixto cuando efectivo + transferencia suman el total", async () => {
    await service.create(
      {
        installment_id: "inst-1",
        generation_type: "RENEWAL",
        amount_cash: 1500,
        amount_transfer: 500,
      },
      ADMIN,
    );

    expect(queries.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount_received: 2000,
        amount_cash: 1500,
        amount_transfer: 500,
        payment_method: "MIXED",
        generation_type: "RENEWAL",
      }),
    );
  });

  it("rechaza 422 si el monto no coincide con el cargo calculado", async () => {
    await expect(
      service.create(
        {
          installment_id: "inst-1",
          generation_type: "RENEWAL",
          payment_method: "CASH",
          amount_received: 1000,
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(queries.create).not.toHaveBeenCalled();
  });

  it("rechaza 409 si la cuota ya tiene una pre-carga pendiente", async () => {
    queries.getPendingCommittedAmount.mockResolvedValue(2000);

    await expect(
      service.create(
        {
          installment_id: "inst-1",
          generation_type: "RENEWAL",
          payment_method: "CASH",
          amount_received: 2000,
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(queries.create).not.toHaveBeenCalled();
  });

  it("rechaza 409 si el préstamo no es renovable (más de una cuota)", async () => {
    queries.getRenewableLoan.mockResolvedValue(
      validLoan({ installments_count: 3 }),
    );

    await expect(
      service.create(
        {
          installment_id: "inst-1",
          generation_type: "RENEWAL",
          payment_method: "CASH",
          amount_received: 2000,
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rechaza 404 si la cuota no existe", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await expect(
      service.create(
        {
          installment_id: "inst-x",
          generation_type: "RENEWAL",
          payment_method: "CASH",
          amount_received: 2000,
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("payments.service.approve — aprobación de una PRE-CARGA de renovación", () => {
  const client = { query: jest.fn() };

  const renewalPayment = (overrides = {}) => ({
    id: "pay-1",
    status: "PENDING",
    generation_type: "RENEWAL",
    installment_id: "inst-1",
    collector_id: "admin-1",
    credit_id: "credit-1",
    payment_frequency: "MONTHLY",
    amount_received: 2000,
    amount_cash: 2000,
    amount_transfer: 0,
    amount_due: 12000,
    amount_paid: 0,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    withTransaction.mockImplementation(async (cb) => cb(client));
    client.query.mockResolvedValue({ rows: [{ status: "OVERDUE" }] });
    cashSessionsQueries.lockActiveSessionForCurrentJornada.mockResolvedValue({
      id: "sess-1",
    });
    queries.lockAndGetPayment.mockResolvedValue(renewalPayment());
    queries.lockAndGetInstallment.mockResolvedValue({
      id: "inst-1",
      status: "OVERDUE",
      payment_frequency: "MONTHLY",
    });
    queries.approve.mockResolvedValue({ id: "pay-1" });
    queries.renewInstallment.mockResolvedValue();
    queries.findById.mockResolvedValue({ id: "pay-1", status: "APPROVED" });
  });

  it("marca APPROVED, corre los efectos de renovación e impacta caja", async () => {
    await service.approve("pay-1", "admin-1");

    expect(queries.approve).toHaveBeenCalledWith(
      client,
      "pay-1",
      "admin-1",
      "sess-1",
    );
    expect(queries.renewInstallment).toHaveBeenCalledWith(
      client,
      "inst-1",
      "MONTHLY",
      3,
    );
    expect(
      collectionAttemptsQueries.voidScheduledVisitsForInstallment,
    ).toHaveBeenCalledWith(client, "inst-1", "admin-1");
    expect(cashMovementsQueries.create).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ amount: 2000, movementType: "PAYMENT" }),
    );
  });

  it("NO aplica el pago a la cuota ni liquida el crédito", async () => {
    await service.approve("pay-1", "admin-1");

    expect(queries.updateInstallment).not.toHaveBeenCalled();
    expect(queries.settleCredit).not.toHaveBeenCalled();
  });

  it("rechaza 409 si la cuota ya fue pagada", async () => {
    queries.lockAndGetInstallment.mockResolvedValue({
      id: "inst-1",
      status: "PAID",
      payment_frequency: "MONTHLY",
    });

    await expect(service.approve("pay-1", "admin-1")).rejects.toMatchObject({
      status: 409,
    });
    expect(queries.renewInstallment).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("payments.service.renewalQuote — cotización de renovación", () => {
  beforeEach(() => jest.clearAllMocks());

  it("devuelve renewable + interés + mora + total para un préstamo renovable", async () => {
    queries.getRenewableLoan.mockResolvedValue(
      validLoan({ penalty_amount: 500, amount_due: 12500 }),
    );

    const q = await service.renewalQuote("credit-1");

    expect(q).toEqual({
      renewable: true,
      interest: 2000,
      mora: 500,
      total: 2500,
    });
  });

  it("renewable:false si el crédito no existe", async () => {
    queries.getRenewableLoan.mockResolvedValue(null);
    expect(await service.renewalQuote("credit-x")).toEqual({
      renewable: false,
    });
  });

  it("renewable:false si no es renovable (más de una cuota)", async () => {
    queries.getRenewableLoan.mockResolvedValue(
      validLoan({ installments_count: 3 }),
    );
    expect(await service.renewalQuote("credit-1")).toEqual({
      renewable: false,
    });
  });
});
