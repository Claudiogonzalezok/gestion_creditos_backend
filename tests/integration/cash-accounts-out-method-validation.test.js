// Integración — #93: todo egreso de Caja General declara su medio.
// POST /api/cash-accounts/:id/movements valida en middleware que los OUT
// lleven payment_method o desglose amount_cash/amount_transfer.

// uuid@13 es ESM-only y jest (CommonJS) no lo carga al importar app.js.
jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));

const request = require("supertest");
const app = require("../../src/app");
const { setupTestSuite } = require("./helpers/db");
const { createUserFixture } = require("./helpers/fixtures");
const { generateInternalToken } = require("../../src/utils/jwt");
const cashAccountsQueries = require("../../src/modules/cashAccounts/cashAccounts.queries");
const cashAccountsService = require("../../src/modules/cashAccounts/cashAccounts.service");

setupTestSuite();

const auth = (user) => ({ Authorization: `Bearer ${generateInternalToken(user)}` });

let admin;
let acc;

beforeEach(async () => {
  admin = await createUserFixture({ role: "ADMIN" });
  acc = await cashAccountsQueries.findGeneralCashAccount();
  await cashAccountsService.registerMovement(
    acc.id,
    { movementType: "MANUAL_INCOME", amount_cash: 1000, amount_transfer: 500 },
    { id: admin.id, role: admin.role },
  );
});

const post = (body) =>
  request(app).post(`/api/cash-accounts/${acc.id}/movements`).set(auth(admin)).send(body);

describe("POST /api/cash-accounts/:id/movements — medio obligatorio en egresos", () => {
  it.each([
    [{ movement_type: "EXPENSE", amount: 100 }],
    [{ movement_type: "SUPPLIER_PAYMENT", amount: 100 }],
    [{ movement_type: "ADJUSTMENT", direction: "OUT", amount: 100 }],
  ])("%p sin medio → 400 y no persiste", async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/payment_method es obligatorio/);
    expect((await cashAccountsService.getBalance(acc.id)).current_balance).toBe(1500);
  });

  it("payment_method inválido → 400", async () => {
    const res = await post({ movement_type: "EXPENSE", amount: 100, payment_method: "CHEQUE" });
    expect(res.status).toBe(400);
  });

  it("payment_method y desglose a la vez → 400", async () => {
    const res = await post({ movement_type: "EXPENSE", amount_cash: 100, payment_method: "CASH" });
    expect(res.status).toBe(400);
  });

  it("EXPENSE con payment_method TRANSFER → 201 y descuenta de transferencia", async () => {
    const res = await post({ movement_type: "EXPENSE", amount: 200, payment_method: "TRANSFER" });
    expect(res.status).toBeLessThan(300);
    const bal = await cashAccountsService.getBalance(acc.id);
    expect(bal).toMatchObject({ current_balance: 1300, cash_balance: 1000, transfer_balance: 300 });
  });

  it("EXPENSE con payment_method CASH mayor al efectivo → 409 INSUFFICIENT_METHOD_BALANCE", async () => {
    const res = await post({ movement_type: "EXPENSE", amount: 1200, payment_method: "CASH" });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/efectivo/);
  });

  it("ingresos (MANUAL_INCOME, ADJUSTMENT IN) siguen sin exigir medio", async () => {
    expect((await post({ movement_type: "MANUAL_INCOME", amount: 50 })).status).toBeLessThan(300);
    expect(
      (await post({ movement_type: "ADJUSTMENT", direction: "IN", amount: 50 })).status,
    ).toBeLessThan(300);
  });
});
