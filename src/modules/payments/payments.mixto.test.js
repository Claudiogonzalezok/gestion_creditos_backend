// Tests del pago mixto (efectivo + transferencia) y del fix de asimetría de
// caja en reversiones con cuotas adelantadas (#1).

jest.mock("../../config/db", () => ({ query: jest.fn() }));

jest.mock("./payments.queries", () => ({
  lockAndGetPayment: jest.fn(),
  approve: jest.fn(),
  lockAndGetInstallment: jest.fn(),
  updateInstallment: jest.fn(),
  getPendingInstallmentsFrom: jest.fn(),
  shiftInstallmentDates: jest.fn(),
  markInstallmentAsPrepaid: jest.fn(),
  lockAndGetCredit: jest.fn(),
  countPendingInstallments: jest.fn(),
  settleCredit: jest.fn(),
  findById: jest.fn(),
  findChildPayments: jest.fn(),
  createReversal: jest.fn(),
  restoreInstallmentFromReversal: jest.fn(),
}));

jest.mock("./cash_movements.queries", () => ({
  create: jest.fn(),
  findPaymentMovement: jest.fn(),
}));

jest.mock("../businessDays/businessDays.queries", () => ({
  findDefaultBranch: jest.fn(),
  isJornadaMutable: jest.fn(),
}));

jest.mock("../businessDays/businessDays.service", () => ({
  getActiveJornadaDate: jest.fn(),
}));

jest.mock("../cashSessions/cashSessions.queries", () => ({
  lockActiveSessionForCurrentJornada: jest.fn(),
}));

jest.mock("../collections/collections.queries", () => ({
  updateManagementStatusForActiveTodaySheet: jest.fn().mockResolvedValue(),
}));

jest.mock("../systemConfig/systemConfig.queries", () => ({
  getValue: jest.fn().mockResolvedValue("3"),
}));

jest.mock("../../utils/transaction", () => ({ withTransaction: jest.fn() }));

const queries = require("./payments.queries");
const cashMovementsQueries = require("./cash_movements.queries");
const businessDaysQueries = require("../businessDays/businessDays.queries");
const { getActiveJornadaDate } = require("../businessDays/businessDays.service");
const cashSessionsQueries = require("../cashSessions/cashSessions.queries");
const { withTransaction } = require("../../utils/transaction");
const service = require("./payments.service");

describe("pago mixto — normalización de montos", () => {
  it("formato mixto: efectivo + transferencia → MIXED con total y desglose", () => {
    const r = service._normalizePaymentAmounts({
      amount_cash: "50000",
      amount_transfer: "30000",
    });
    expect(r).toEqual({
      amountReceived: 80000,
      amountCash: 50000,
      amountTransfer: 30000,
      paymentMethod: "MIXED",
    });
  });

  it("formato mixto degenerado (solo efectivo) → CASH", () => {
    const r = service._normalizePaymentAmounts({ amount_cash: "1000" });
    expect(r).toEqual({
      amountReceived: 1000,
      amountCash: 1000,
      amountTransfer: 0,
      paymentMethod: "CASH",
    });
  });

  it("formato legacy CASH → todo el monto a efectivo", () => {
    const r = service._normalizePaymentAmounts({
      amount_received: "1000",
      payment_method: "CASH",
    });
    expect(r).toEqual({
      amountReceived: 1000,
      amountCash: 1000,
      amountTransfer: 0,
      paymentMethod: "CASH",
    });
  });

  it("formato legacy TRANSFER → todo el monto a transferencia", () => {
    const r = service._normalizePaymentAmounts({
      amount_received: "1000",
      payment_method: "TRANSFER",
    });
    expect(r).toEqual({
      amountReceived: 1000,
      amountCash: 0,
      amountTransfer: 1000,
      paymentMethod: "TRANSFER",
    });
  });
});

describe("pago mixto — split de caja al aprobar", () => {
  const client = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    withTransaction.mockImplementation(async (cb) => cb(client));
    client.query.mockResolvedValue({ rows: [{ status: "PAID" }] });
    getActiveJornadaDate.mockResolvedValue("2026-05-01");
    businessDaysQueries.findDefaultBranch.mockResolvedValue({ id: "branch-hq" });
    businessDaysQueries.isJornadaMutable.mockResolvedValue(true);
    cashSessionsQueries.lockActiveSessionForCurrentJornada.mockResolvedValue({
      id: "cs-1",
      status: "OPEN",
    });
    queries.lockAndGetCredit.mockResolvedValue({
      id: "credit-1",
      status: "ACTIVE",
    });
    queries.countPendingInstallments.mockResolvedValue(0);
    queries.findById.mockResolvedValue({ id: "payment-1", status: "APPROVED" });
  });

  it("genera DOS movimientos de caja (CASH + TRANSFER) para un cobro mixto", async () => {
    queries.lockAndGetPayment.mockResolvedValue({
      id: "payment-1",
      installment_id: "inst-1",
      collector_id: "col-1",
      amount_received: 80000,
      amount_cash: 50000,
      amount_transfer: 30000,
      payment_method: "MIXED",
      transfer_reference: "TRF-1",
      status: "PENDING",
      amount_due: 80000,
      amount_paid: 0,
      installment_number: 1,
      due_date: "2026-05-04",
      credit_id: "credit-1",
      payment_frequency: "WEEKLY",
    });
    queries.lockAndGetInstallment.mockResolvedValue({
      id: "inst-1",
      credit_id: "credit-1",
      installment_number: 1,
      due_date: "2026-05-04",
      amount_due: 80000,
      amount_paid: 0,
      penalty_amount: 0,
      status: "PENDING",
      payment_frequency: "WEEKLY",
    });
    queries.updateInstallment.mockResolvedValue("PAID");
    queries.getPendingInstallmentsFrom.mockResolvedValue([]);

    await service.approve("payment-1", "admin-1");

    expect(cashMovementsQueries.create).toHaveBeenCalledTimes(2);
    const calls = cashMovementsQueries.create.mock.calls.map((c) => c[1]);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paymentMethod: "CASH", amount: 50000 }),
        expect.objectContaining({ paymentMethod: "TRANSFER", amount: 30000 }),
      ]),
    );
  });
});

describe("reverse — fix #1: solo la cabecera impacta caja", () => {
  const client = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    withTransaction.mockImplementation(async (cb) => cb(client));
    client.query.mockResolvedValue({ rows: [] });
    businessDaysQueries.findDefaultBranch.mockResolvedValue({ id: "branch-hq" });
    businessDaysQueries.isJornadaMutable.mockResolvedValue(true);
    cashSessionsQueries.lockActiveSessionForCurrentJornada.mockResolvedValue({
      id: "cs-1",
      status: "OPEN",
    });
    cashMovementsQueries.findPaymentMovement.mockResolvedValue({
      register_date: "2026-05-01",
    });
    queries.lockAndGetInstallment.mockResolvedValue({ id: "inst-1" });
    queries.lockAndGetCredit.mockResolvedValue({
      id: "credit-1",
      status: "ACTIVE",
    });
    queries.restoreInstallmentFromReversal.mockResolvedValue();
    queries.createReversal
      .mockResolvedValueOnce({ id: "rev-header" })
      .mockResolvedValueOnce({ id: "rev-child" });
    queries.findById.mockResolvedValue({ id: "payment-1", status: "APPROVED" });
  });

  it("un cobro con cuota adelantada revierte caja SOLO por la cabecera; el hijo no toca caja", async () => {
    // Cabecera: $2000 efectivo que cubrió su cuota ($1000) y adelantó otra ($1000).
    queries.lockAndGetPayment.mockResolvedValue({
      id: "payment-1",
      installment_id: "inst-1",
      collector_id: "col-1",
      amount_received: 2000,
      amount_cash: 2000,
      amount_transfer: 0,
      payment_method: "CASH",
      transfer_reference: null,
      status: "APPROVED",
      is_reversal: false,
      parent_payment_id: null,
      reversal_payment_id: null,
      credit_id: "credit-1",
    });
    // Hijo: el adelanto generado por distribución.
    queries.findChildPayments.mockResolvedValue([
      {
        id: "child-1",
        installment_id: "inst-2",
        amount_received: 1000,
        amount_cash: 1000,
        amount_transfer: 0,
        payment_method: "CASH",
        transfer_reference: null,
      },
    ]);

    await service.reverse("payment-1", "Error de carga", "admin-1");

    // Se crean dos registros de reversión (cabecera + hijo) para auditoría...
    expect(queries.createReversal).toHaveBeenCalledTimes(2);
    expect(queries.createReversal.mock.calls[0][1]).toMatchObject({
      originalPaymentId: "payment-1",
      cashSessionId: "cs-1",
      amountCash: 2000,
    });
    // ...pero el hijo NO se imputa a ninguna caja.
    expect(queries.createReversal.mock.calls[1][1]).toMatchObject({
      originalPaymentId: "child-1",
      cashSessionId: null,
    });

    // Caja: un único movimiento de reversión, por la cabecera ($2000 efectivo).
    // Antes del fix se generaban 2 (cabecera + hijo) → descuadre.
    expect(cashMovementsQueries.create).toHaveBeenCalledTimes(1);
    expect(cashMovementsQueries.create.mock.calls[0][1]).toMatchObject({
      movementType: "REVERSAL",
      paymentMethod: "CASH",
      amount: 2000,
    });

    // Ambas cuotas se restauran (cabecera + hijo).
    expect(queries.restoreInstallmentFromReversal).toHaveBeenCalledTimes(2);
  });
});
