// Cambio de plan — Etapa 1: tests de la SIMULACIÓN (sin DB, queries mockeadas).

jest.mock("../../config/db", () => ({ query: jest.fn() }));
jest.mock("./credits.queries", () => ({
  findById: jest.fn(),
  lockCredit: jest.fn(),
  lockInstallments: jest.fn(),
  hasPendingPayments: jest.fn(),
  setSurvivingInstallment: jest.fn(),
  cancelInstallmentsForPlanChange: jest.fn(),
  settleCreditByPlanChange: jest.fn(),
  createPlanChangeRecord: jest.fn(),
  hasPlanChange: jest.fn(),
}));
jest.mock("../interestRates/interestRates.queries", () => ({
  findActiveRate: jest.fn(),
}));
jest.mock("../systemConfig/systemConfig.queries", () => ({
  getValue: jest.fn().mockResolvedValue("3"),
}));
jest.mock("../../utils/transaction", () => ({
  withTransaction: jest.fn(),
}));

const queries = require("./credits.queries");
const irQueries = require("../interestRates/interestRates.queries");
const { withTransaction } = require("../../utils/transaction");
const service = require("./credits.service");

// Helpers para construir un crédito LOAN con cuotas.
const inst = (number, status, amountPaid, amountDue = 20000, id = `i${number}`) => ({
  id,
  installment_number: number,
  due_date: "2026-01-01",
  original_due_date: null,
  amount_due: amountDue,
  amount_paid: amountPaid,
  penalty_amount: 0,
  status,
});

const credit = (overrides = {}) => ({
  id: "credit-1",
  type: "LOAN",
  total_amount: 100000,
  down_payment: 0,
  installments_count: 6,
  payment_frequency: "MONTHLY",
  interest_rate: 0.2,
  status: "ACTIVE",
  installments: [],
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

describe("simulatePlanChange — cálculo (caso del negocio 6→3)", () => {
  it("recalcula saldo con la tasa del plan más corto y deja una cuota viva", async () => {
    queries.findById.mockResolvedValue(
      credit({
        installments: [
          inst(1, "PAID", 20000),
          inst(2, "PAID", 20000),
          inst(3, "PENDING", 0),
          inst(4, "PENDING", 0),
          inst(5, "PENDING", 0),
          inst(6, "PENDING", 0),
        ],
      }),
    );
    irQueries.findActiveRate.mockResolvedValue({ rate: 0.1 });

    const r = await service.simulatePlanChange("credit-1");

    expect(irQueries.findActiveRate).toHaveBeenCalledWith("MONTHLY", 3, 100000);
    expect(r).toEqual({
      currentPlan: { installments: 6, rate: 20 },
      newPlan: { installments: 3, rate: 10 },
      totalPaid: 40000,
      newCreditTotal: 110000,
      newBalance: 70000,
      survivingInstallmentId: "i3",
      cancelledInstallments: [4, 5, 6],
      creditWillBeSettled: false,
    });
  });
});

describe("simulatePlanChange — validaciones", () => {
  it("rechaza créditos SALE (V1 solo LOAN) → 422", async () => {
    queries.findById.mockResolvedValue(credit({ type: "SALE" }));
    await expect(service.simulatePlanChange("credit-1")).rejects.toMatchObject({
      status: 422,
    });
  });

  it("rechaza crédito no ACTIVE → 409", async () => {
    queries.findById.mockResolvedValue(credit({ status: "SETTLED" }));
    await expect(service.simulatePlanChange("credit-1")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("404 si el crédito no existe", async () => {
    queries.findById.mockResolvedValue(null);
    await expect(service.simulatePlanChange("x")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("rechaza si no existe tasa para el plan destino → 422", async () => {
    queries.findById.mockResolvedValue(
      credit({
        installments: [
          inst(1, "PAID", 20000),
          inst(2, "PENDING", 0),
          inst(3, "PENDING", 0),
          inst(4, "PENDING", 0),
          inst(5, "PENDING", 0),
          inst(6, "PENDING", 0),
        ],
      }),
    );
    irQueries.findActiveRate.mockResolvedValue(null);
    await expect(service.simulatePlanChange("credit-1")).rejects.toMatchObject({
      status: 422,
    });
  });

  it("rechaza cuotas pagadas fuera de orden → 409", async () => {
    queries.findById.mockResolvedValue(
      credit({
        installments: [
          inst(1, "PAID", 20000),
          inst(2, "PENDING", 0),
          inst(3, "PAID", 20000), // PAID después de una PENDING
          inst(4, "PENDING", 0),
          inst(5, "PENDING", 0),
          inst(6, "PENDING", 0),
        ],
      }),
    );
    await expect(service.simulatePlanChange("credit-1")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rechaza si el plan destino no es más corto que el actual → 409", async () => {
    // 6 cuotas, 5 pagadas → nuevo_plan = 6 = plan actual → no es más corto.
    queries.findById.mockResolvedValue(
      credit({
        installments: [
          inst(1, "PAID", 20000),
          inst(2, "PAID", 20000),
          inst(3, "PAID", 20000),
          inst(4, "PAID", 20000),
          inst(5, "PAID", 20000),
          inst(6, "PENDING", 0),
        ],
      }),
    );
    await expect(service.simulatePlanChange("credit-1")).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("simulatePlanChange — saldo ≤ 0 cancela el crédito", () => {
  it("survivingInstallmentId null y creditWillBeSettled true", async () => {
    // 12 cuotas de 10000; 10 pagadas (100000); plan destino 11 con tasa 0% → total 100000.
    const installments = [];
    for (let n = 1; n <= 12; n++) {
      installments.push(
        inst(n, n <= 10 ? "PAID" : "PENDING", n <= 10 ? 10000 : 0, 10000),
      );
    }
    queries.findById.mockResolvedValue(
      credit({ installments_count: 12, installments }),
    );
    irQueries.findActiveRate.mockResolvedValue({ rate: 0 });

    const r = await service.simulatePlanChange("credit-1");

    expect(r.newBalance).toBe(0);
    expect(r.survivingInstallmentId).toBeNull();
    expect(r.creditWillBeSettled).toBe(true);
    expect(r.cancelledInstallments).toEqual([12]);
  });
});

describe("changePlan — ejecución (Etapa 2)", () => {
  const client = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    withTransaction.mockImplementation(async (cb) => cb(client));
    queries.hasPendingPayments.mockResolvedValue(false);
    queries.setSurvivingInstallment.mockResolvedValue();
    queries.cancelInstallmentsForPlanChange.mockResolvedValue();
    queries.settleCreditByPlanChange.mockResolvedValue();
    queries.createPlanChangeRecord.mockResolvedValue({
      id: "pc-1",
      executed_at: "2026-06-15T00:00:00Z",
    });
  });

  it("saldo > 0: recalcula la sobreviviente, anula futuras, NO cancela el crédito", async () => {
    queries.lockCredit.mockResolvedValue(credit()); // 6 cuotas, 20%, 100000
    queries.lockInstallments.mockResolvedValue([
      inst(1, "PAID", 20000),
      inst(2, "PAID", 20000),
      inst(3, "PENDING", 0),
      inst(4, "PENDING", 0),
      inst(5, "PENDING", 0),
      inst(6, "PENDING", 0),
    ]);
    irQueries.findActiveRate.mockResolvedValue({ rate: 0.1 });

    const r = await service.changePlan("credit-1", { reason: "ok" }, "admin-1");

    expect(queries.setSurvivingInstallment).toHaveBeenCalledWith(
      client,
      "i3",
      70000,
      3,
    );
    expect(queries.cancelInstallmentsForPlanChange).toHaveBeenCalledWith(client, [
      "i4",
      "i5",
      "i6",
    ]);
    expect(queries.settleCreditByPlanChange).not.toHaveBeenCalled();
    expect(queries.createPlanChangeRecord).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        credit_id: "credit-1",
        surviving_installment_id: "i3",
        credit_cancelled: false,
        new_balance: 70000,
        executed_by: "admin-1",
      }),
    );
    expect(r).toMatchObject({ newBalance: 70000, plan_change_id: "pc-1" });
  });

  it("saldo ≤ 0: anula todas las pendientes y cancela el crédito", async () => {
    const installments = [];
    for (let n = 1; n <= 12; n++) {
      installments.push(
        inst(n, n <= 10 ? "PAID" : "PENDING", n <= 10 ? 10000 : 0, 10000),
      );
    }
    queries.lockCredit.mockResolvedValue(credit({ installments_count: 12 }));
    queries.lockInstallments.mockResolvedValue(installments);
    irQueries.findActiveRate.mockResolvedValue({ rate: 0 });

    await service.changePlan("credit-1", {}, "admin-1");

    expect(queries.settleCreditByPlanChange).toHaveBeenCalledWith(client, "credit-1");
    expect(queries.cancelInstallmentsForPlanChange).toHaveBeenCalledWith(client, [
      "i11",
      "i12",
    ]);
    expect(queries.setSurvivingInstallment).not.toHaveBeenCalled();
    expect(queries.createPlanChangeRecord).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ credit_cancelled: true, surviving_installment_id: null }),
    );
  });

  it("bloquea si hay cobros PENDING (409) y no muta nada", async () => {
    queries.lockCredit.mockResolvedValue(credit());
    queries.hasPendingPayments.mockResolvedValue(true);

    await expect(
      service.changePlan("credit-1", {}, "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(queries.lockInstallments).not.toHaveBeenCalled();
    expect(queries.setSurvivingInstallment).not.toHaveBeenCalled();
    expect(queries.settleCreditByPlanChange).not.toHaveBeenCalled();
    expect(queries.createPlanChangeRecord).not.toHaveBeenCalled();
  });

  it("404 si el crédito no existe", async () => {
    queries.lockCredit.mockResolvedValue(null);
    await expect(
      service.changePlan("x", {}, "admin-1"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("cambio de plan — solo se permite una vez", () => {
  const client = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    withTransaction.mockImplementation(async (cb) => cb(client));
  });

  it("simular rechaza si el crédito ya tuvo un cambio de plan (409)", async () => {
    queries.findById.mockResolvedValue(credit());
    queries.hasPlanChange.mockResolvedValue(true);

    await expect(
      service.simulatePlanChange("credit-1"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("ejecutar rechaza un segundo cambio de plan y no muta nada (409)", async () => {
    queries.lockCredit.mockResolvedValue(credit());
    queries.hasPlanChange.mockResolvedValue(true);

    await expect(
      service.changePlan("credit-1", {}, "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(queries.lockInstallments).not.toHaveBeenCalled();
    expect(queries.setSurvivingInstallment).not.toHaveBeenCalled();
    expect(queries.createPlanChangeRecord).not.toHaveBeenCalled();
  });
});
