jest.mock("../../config/db", () => ({
  query: jest.fn(),
}));

jest.mock("./credits.queries", () => ({
  findById: jest.fn(),
  approve: jest.fn(),
  generateInstallments: jest.fn(),
  findCreditUnits: jest.fn(),
  saveHistoricalRate: jest.fn(),
  createDownPayment: jest.fn(),
  createCommission: jest.fn(),
  updateCreditSeller: jest.fn(),
  setPrepaidInstallmentsDueDate: jest.fn(),
  settleCredit: jest.fn(),
}));

jest.mock("../payments/payments.service", () => ({
  generatePrepaidInstallmentPayments: jest.fn(),
  _normalizePaymentAmounts: jest.fn(),
}));

jest.mock("../users/users.queries", () => ({
  findById: jest.fn(),
}));

jest.mock("../interestRates/interestRates.queries", () => ({
  findActiveRate: jest.fn(),
}));

jest.mock("../productRates/productRates.queries", () => ({
  findActiveRate: jest.fn(),
}));

jest.mock("../productUnits/productUnits.queries", () => ({
  updateStatusBulk: jest.fn(),
}));

jest.mock("../systemConfig/systemConfig.queries", () => ({
  getValue: jest.fn(),
}));

jest.mock("../../utils/transaction", () => ({
  withTransaction: jest.fn(),
}));

jest.mock("../cashRegister/cashRegister.queries", () => ({
  findUnclosedJornadaDate: jest.fn().mockResolvedValue(null),
}));

jest.mock("../businessDays/businessDays.queries", () => ({
  findDefaultBranch: jest.fn(),
  findActiveJornadaDate: jest.fn(),
}));

jest.mock("../cashSessions/cashSessions.queries", () => ({
  lockActiveSessionForCurrentJornada: jest.fn(),
}));

jest.mock("../../utils/businessDay", () => {
  const actual = jest.requireActual("../../utils/businessDay");
  return {
    ...actual,
    getActiveHolidayKeysInRange: jest.fn(),
  };
});

const pool = require("../../config/db");
const queries = require("./credits.queries");
const irQueries = require("../interestRates/interestRates.queries");
const prQueries = require("../productRates/productRates.queries");
const puQueries = require("../productUnits/productUnits.queries");
const usersQueries = require("../users/users.queries");
const { getValue } = require("../systemConfig/systemConfig.queries");
const { withTransaction } = require("../../utils/transaction");
const businessDaysQueries = require("../businessDays/businessDays.queries");
const cashSessionsQueries = require("../cashSessions/cashSessions.queries");
const paymentsService = require("../payments/payments.service");
const { getActiveHolidayKeysInRange } = require("../../utils/businessDay");
const service = require("./credits.service");

const toKey = (date) => {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

describe("credits.service holiday integration", () => {
  const client = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date(2026, 3, 24, 12, 0, 0, 0));
    withTransaction.mockImplementation(async (callback) => callback(client));
    getActiveHolidayKeysInRange.mockResolvedValue(new Set(["2026-05-01"]));
    getValue.mockResolvedValue("0.08");
    businessDaysQueries.findDefaultBranch.mockResolvedValue({
      id: "branch-hq",
    });
    businessDaysQueries.findActiveJornadaDate.mockResolvedValue("2026-04-24");
    cashSessionsQueries.lockActiveSessionForCurrentJornada.mockResolvedValue({
      id: "cash-session-1",
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("mueve al próximo día hábil una simulación LOAN cuando la primera cuota cae en feriado", async () => {
    irQueries.findActiveRate.mockResolvedValue({ rate: 0.1 });

    const result = await service.simulate({
      type: "LOAN",
      total_amount: 100000,
      installments_count: 2,
      payment_frequency: "WEEKLY",
      first_payment_date: "2026-05-01",
    });

    expect(getActiveHolidayKeysInRange).toHaveBeenCalled();
    // 2026-05-01 vie feriado → 2026-05-02 sabado HABIL (cliente decidio
    // sabado operativo, 2026-06). 2026-05-08 vie habil sigue igual.
    expect(result.schedule.map((row) => row.due_date)).toEqual([
      '2026-05-02',
      '2026-05-08',
    ]);
  });

  it("mueve al próximo día hábil las cuotas al aprobar un LOAN con feriado cargado", async () => {
    queries.findById
      .mockResolvedValueOnce({
        id: "credit-loan-1",
        type: "LOAN",
        status: "PENDING_APPROVAL",
        payment_frequency: "WEEKLY",
        installments_count: 2,
        total_amount: 100000,
      })
      .mockResolvedValueOnce({
        id: "credit-loan-1",
        type: "LOAN",
        status: "ACTIVE",
      });
    irQueries.findActiveRate.mockResolvedValue({ rate: 0.1 });

    await service.approve("credit-loan-1", "admin-1");

    expect(queries.generateInstallments).toHaveBeenCalled();
    const dueDates = queries.generateInstallments.mock.calls[0][3].map(toKey);
    expect(dueDates).toEqual(['2026-05-02', '2026-05-08']);
  });

  it("mueve al próximo día hábil las cuotas al aprobar una SALE con feriado cargado", async () => {
    queries.findById
      .mockResolvedValueOnce({
        id: "credit-sale-1",
        type: "SALE",
        status: "PENDING_APPROVAL",
        payment_frequency: "WEEKLY",
        installments_count: 2,
        total_amount: 100000,
        down_payment: 0,
        created_by: "seller-1",
      })
      .mockResolvedValueOnce({
        id: "credit-sale-1",
        type: "SALE",
        status: "ACTIVE",
      });
    queries.findCreditUnits.mockResolvedValue([
      {
        unit_id: "unit-1",
        unit_status: "RESERVED",
        historical_price: 100000,
        product_id: "product-1",
        title: "Producto demo",
        credit_product_id: "cp-1",
      },
    ]);
    prQueries.findActiveRate.mockResolvedValue({ rate: 0.1 });

    await service.approve("credit-sale-1", "admin-1");

    expect(queries.generateInstallments).toHaveBeenCalled();
    const dueDates = queries.generateInstallments.mock.calls[0][3].map(toKey);
    expect(dueDates).toEqual(['2026-05-02', '2026-05-08']);
    expect(puQueries.updateStatusBulk).toHaveBeenCalledWith(client, ['unit-1'], 'SOLD');
  });

  it("mueve al próximo día hábil el cronograma de una simulación SALE", async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          id: "variant-1",
          current_price: 100000,
          variant_status: "ACTIVE",
          color: "Negro",
          size: null,
          capacity: "128GB",
          product_id: "product-1",
          title: "Producto demo",
          product_status: "ACTIVE",
        },
      ],
    });
    prQueries.findActiveRate.mockResolvedValue({ rate: 0.1 });

    const result = await service.simulate({
      type: "SALE",
      products: [
        { variant_id: "variant-1", quantity: 1, installments_count: 2 },
      ],
      installments_count: 2,
      payment_frequency: "WEEKLY",
      first_payment_date: "2026-05-01",
      down_payment: 0,
    });

    expect(result.schedule.map((row) => row.due_date)).toEqual([
      '2026-05-02',
      '2026-05-08',
    ]);
  });

  it("imputa el enganche a la jornada activa aunque el día calendario sea otro — CA-04", async () => {
    businessDaysQueries.findActiveJornadaDate.mockResolvedValue("2026-04-23");
    queries.findById
      .mockResolvedValueOnce({
        id: "credit-sale-1",
        type: "SALE",
        status: "PENDING_APPROVAL",
        payment_frequency: "WEEKLY",
        installments_count: 2,
        total_amount: 100000,
        down_payment: 15000,
        down_payment_method: "CASH",
        down_payment_transfer_reference: null,
      })
      .mockResolvedValueOnce({
        id: "credit-sale-1",
        type: "SALE",
        status: "ACTIVE",
      });
    queries.findCreditUnits.mockResolvedValue([
      {
        unit_id: "unit-1",
        unit_status: "RESERVED",
        historical_price: 100000,
        product_id: "product-1",
        title: "Producto demo",
        credit_product_id: "cp-1",
      },
    ]);
    prQueries.findActiveRate.mockResolvedValue({ rate: 0.1 });

    await service.approve("credit-sale-1", "admin-1");

    expect(queries.createDownPayment).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        creditId: "credit-sale-1",
        amount: 15000,
        paymentMethod: "CASH",
        approvedBy: "admin-1",
        registerDate: "2026-04-23",
        cashSessionId: "cash-session-1",
      }),
    );
  });
});

describe("credits.service changeSeller", () => {
  const client = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    withTransaction.mockImplementation(async (callback) => callback(client));
  });

  const pendingCredit = {
    id: "credit-1",
    status: "PENDING_APPROVAL",
    created_by: "seller-old",
  };
  const validSeller = { id: "seller-new", role: "SELLER", status: "ACTIVE" };

  it("reasigna created_by cuando todo es válido y el crédito está pendiente", async () => {
    queries.findById
      .mockResolvedValueOnce(pendingCredit) // lectura inicial
      .mockResolvedValueOnce({ ...pendingCredit, created_by: "seller-new" }); // retorno final
    usersQueries.findById.mockResolvedValue(validSeller);
    queries.updateCreditSeller.mockResolvedValue(1);

    await service.changeSeller("credit-1", "seller-new", "admin-1");

    expect(queries.updateCreditSeller).toHaveBeenCalledWith(
      client,
      "credit-1",
      "seller-new",
    );
  });

  it("rechaza (404) si el crédito no existe", async () => {
    queries.findById.mockResolvedValue(null);
    await expect(
      service.changeSeller("x", "seller-new", "admin-1"),
    ).rejects.toMatchObject({ status: 404 });
    expect(queries.updateCreditSeller).not.toHaveBeenCalled();
  });

  it("rechaza (409) si el crédito no está PENDING_APPROVAL", async () => {
    queries.findById.mockResolvedValue({ ...pendingCredit, status: "ACTIVE" });
    await expect(
      service.changeSeller("credit-1", "seller-new", "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(queries.updateCreditSeller).not.toHaveBeenCalled();
  });

  it("rechaza (409) si el vendedor elegido es el mismo", async () => {
    queries.findById.mockResolvedValue(pendingCredit);
    await expect(
      service.changeSeller("credit-1", "seller-old", "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(usersQueries.findById).not.toHaveBeenCalled();
    expect(queries.updateCreditSeller).not.toHaveBeenCalled();
  });

  it("rechaza (404) si el vendedor no existe o está inactivo", async () => {
    queries.findById.mockResolvedValue(pendingCredit);
    usersQueries.findById.mockResolvedValue({ ...validSeller, status: "INACTIVE" });
    await expect(
      service.changeSeller("credit-1", "seller-new", "admin-1"),
    ).rejects.toMatchObject({ status: 404 });
    expect(queries.updateCreditSeller).not.toHaveBeenCalled();
  });

  it("rechaza (400) si el usuario no tiene rol de vendedor", async () => {
    queries.findById.mockResolvedValue(pendingCredit);
    usersQueries.findById.mockResolvedValue({ ...validSeller, role: "COLLECTOR" });
    await expect(
      service.changeSeller("credit-1", "seller-new", "admin-1"),
    ).rejects.toMatchObject({ status: 400 });
    expect(queries.updateCreditSeller).not.toHaveBeenCalled();
  });

  it("rechaza (409) si el UPDATE no afecta filas (dejó de estar pendiente bajo carrera)", async () => {
    queries.findById.mockResolvedValue(pendingCredit);
    usersQueries.findById.mockResolvedValue(validSeller);
    queries.updateCreditSeller.mockResolvedValue(0);
    await expect(
      service.changeSeller("credit-1", "seller-new", "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("credits.service approve — venta de CONTADO", () => {
  const client = { query: jest.fn() };

  const cashCredit = (overrides = {}) => ({
    id: "credit-cash-1",
    type: "SALE",
    payment_condition: "CASH",
    status: "PENDING_APPROVAL",
    payment_frequency: "WEEKLY",
    installments_count: 1,
    total_amount: 100000,
    down_payment: 0,
    created_by: "seller-1",
    prepaid_installments: 0,
    prepaid_installments_method: "CASH",
    prepaid_installments_cash: 100000,
    prepaid_installments_transfer: 0,
    prepaid_installments_transfer_reference: null,
    ...overrides,
  });

  const reservedUnit = {
    unit_id: "unit-1",
    unit_status: "RESERVED",
    historical_price: 100000,
    product_id: "product-1",
    title: "Producto demo",
    credit_product_id: "cp-1",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date(2026, 3, 24, 12, 0, 0, 0));
    withTransaction.mockImplementation(async (callback) => callback(client));
    getValue.mockResolvedValue("0.08");
    cashSessionsQueries.lockActiveSessionForCurrentJornada.mockResolvedValue({
      id: "cash-session-1",
    });
    queries.generateInstallments.mockResolvedValue([
      { id: "inst-1", installment_number: 1, amount_due: 100000 },
    ]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("aprueba: 1 cuota al precio total, cobro a caja, comisión y SETTLED", async () => {
    queries.findById
      .mockResolvedValueOnce(cashCredit())
      .mockResolvedValueOnce({ ...cashCredit(), status: "SETTLED" });
    queries.findCreditUnits.mockResolvedValue([reservedUnit]);

    await service.approve("credit-cash-1", "admin-1");

    // Aprobación sin tasa, una sola cuota.
    expect(queries.approve).toHaveBeenCalledWith(
      client,
      "credit-cash-1",
      "admin-1",
      null,
      1,
    );
    // La cuota vale el total (sin interés) y es única.
    const genCall = queries.generateInstallments.mock.calls[0];
    expect(genCall[2]).toBe(100000);
    expect(genCall[3]).toHaveLength(1);
    expect(queries.setPrepaidInstallmentsDueDate).toHaveBeenCalledWith(
      client,
      "credit-cash-1",
      1,
    );
    // Cobro imputado a la caja activa por el mecanismo de pagos.
    expect(
      paymentsService.generatePrepaidInstallmentPayments,
    ).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        installments: [{ id: "inst-1", amountDue: 100000 }],
        amountCash: 100000,
        amountTransfer: 0,
        cashSessionId: "cash-session-1",
      }),
    );
    // Stock vendido, comisión sobre el total y crédito saldado.
    expect(puQueries.updateStatusBulk).toHaveBeenCalledWith(
      client,
      ["unit-1"],
      "SOLD",
    );
    expect(queries.createCommission).toHaveBeenCalledWith(
      client,
      "seller-1",
      "credit-cash-1",
      8000,
      expect.anything(),
      expect.anything(),
    );
    expect(queries.settleCredit).toHaveBeenCalledWith(client, "credit-cash-1");
  });

  it("respeta el split por transferencia declarado al crear", async () => {
    queries.findById
      .mockResolvedValueOnce(
        cashCredit({
          prepaid_installments_method: "TRANSFER",
          prepaid_installments_cash: 0,
          prepaid_installments_transfer: 100000,
          prepaid_installments_transfer_reference: "OP-123",
        }),
      )
      .mockResolvedValueOnce({ ...cashCredit(), status: "SETTLED" });
    queries.findCreditUnits.mockResolvedValue([reservedUnit]);

    await service.approve("credit-cash-1", "admin-1");

    expect(
      paymentsService.generatePrepaidInstallmentPayments,
    ).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        amountCash: 0,
        amountTransfer: 100000,
        transferReference: "OP-123",
      }),
    );
  });

  it("rechaza (409 NO_ACTIVE_SESSION) si no hay caja operativa abierta", async () => {
    queries.findById.mockResolvedValueOnce(cashCredit());
    queries.findCreditUnits.mockResolvedValue([reservedUnit]);
    cashSessionsQueries.lockActiveSessionForCurrentJornada.mockResolvedValue(
      null,
    );

    await expect(
      service.approve("credit-cash-1", "admin-1"),
    ).rejects.toMatchObject({ status: 409, code: "NO_ACTIVE_SESSION" });
    expect(queries.settleCredit).not.toHaveBeenCalled();
  });

  it("rechaza (409) si una unidad ya no está RESERVED", async () => {
    queries.findById.mockResolvedValueOnce(cashCredit());
    queries.findCreditUnits.mockResolvedValue([
      { ...reservedUnit, unit_status: "SOLD" },
    ]);

    await expect(
      service.approve("credit-cash-1", "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(queries.approve).not.toHaveBeenCalled();
  });
});
