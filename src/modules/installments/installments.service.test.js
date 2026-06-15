// GAP #2: el pago anticipado de cuota (/early-pay) debe imputar el ingreso a la
// caja, delegando en el cobro directo del admin. Antes insertaba el pago sin
// cash_session_id ni movimiento → dinero invisible para la contabilidad.

jest.mock("../../config/db", () => ({ query: jest.fn() }));
jest.mock("./installments.queries", () => ({ findById: jest.fn() }));
jest.mock("../payments/payments.queries", () => ({
  getPendingCommittedAmount: jest.fn(),
}));
jest.mock("../payments/payments.service", () => ({ adminDirect: jest.fn() }));
jest.mock("../systemConfig/systemConfig.queries", () => ({ getValue: jest.fn() }));

const pool = require("../../config/db");
const queries = require("./installments.queries");
const paymentsQueries = require("../payments/payments.queries");
const paymentsService = require("../payments/payments.service");
const service = require("./installments.service");

describe("installments.earlyPay — imputa a caja vía adminDirect", () => {
  beforeEach(() => jest.clearAllMocks());

  it("delega en adminDirect con el saldo pendiente real y refleja credit_settled", async () => {
    queries.findById
      .mockResolvedValueOnce({
        id: "inst-1",
        credit_id: "c1",
        amount_due: 1000,
        amount_paid: 200,
        status: "OVERDUE",
      })
      .mockResolvedValueOnce({
        id: "inst-1",
        credit_id: "c1",
        amount_due: 1000,
        amount_paid: 1000,
        status: "PAID",
      });
    paymentsQueries.getPendingCommittedAmount.mockResolvedValue(0);
    paymentsService.adminDirect.mockResolvedValue({ id: "pay-1" });
    pool.query.mockResolvedValue({ rows: [{ status: "SETTLED" }] });

    const res = await service.earlyPay("inst-1", "CASH", null, "admin-1");

    expect(paymentsService.adminDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        installment_id: "inst-1",
        amount_received: 800, // 1000 - 200
        payment_method: "CASH",
      }),
      "admin-1",
    );
    expect(res.credit_settled).toBe(true);
  });

  it("bloquea si la cuota tiene pre-cargas PENDING (no delega)", async () => {
    queries.findById.mockResolvedValue({
      id: "inst-1",
      credit_id: "c1",
      amount_due: 1000,
      amount_paid: 0,
      status: "OVERDUE",
    });
    paymentsQueries.getPendingCommittedAmount.mockResolvedValue(500);

    await expect(
      service.earlyPay("inst-1", "CASH", null, "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(paymentsService.adminDirect).not.toHaveBeenCalled();
  });

  it("rechaza una cuota ya pagada", async () => {
    queries.findById.mockResolvedValue({
      id: "inst-1",
      credit_id: "c1",
      amount_due: 1000,
      amount_paid: 1000,
      status: "PAID",
    });

    await expect(
      service.earlyPay("inst-1", "CASH", null, "admin-1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(paymentsService.adminDirect).not.toHaveBeenCalled();
  });
});
