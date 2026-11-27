// Integración — validaciones de caja operativa:
//   #116 · Un gasto TRANSFER no puede superar el saldo en transferencia de la caja.
//   #117 · Una conversión DAILY no puede superar el saldo del medio de origen.
//   #118 · Montos fuera de rango → 400 (no 500) en los endpoints de caja.
//   #119 · Conversiones usan la fecha de la jornada; gastos fuera de [jornada, hoy] → 400.
//   Los 409 incluyen el `code` que setea el service.

// uuid@13 es ESM-only y jest (CommonJS) no lo carga al importar app.js.
jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));

const request = require("supertest");
const app = require("../../src/app");
const { pool, setupTestSuite } = require("./helpers/db");
const { createUserFixture } = require("./helpers/fixtures");
const { today } = require("./helpers/dates");
const { generateInternalToken } = require("../../src/utils/jwt");
const cashSessionsService = require("../../src/modules/cashSessions/cashSessions.service");
const cashAccountsQueries = require("../../src/modules/cashAccounts/cashAccounts.queries");

setupTestSuite();

const BIG = 1e12;

let admin;
let session;
let categoryId;

const auth = () => ({ Authorization: `Bearer ${generateInternalToken(admin)}` });
const post = (url, body) => request(app).post(url).set(auth()).send(body);

/**
 * Abre la caja de la jornada con el efectivo indicado y, si corresponde,
 * carga saldo en transferencia con un ingreso manual.
 */
const openSession = async ({ cash = 0, transfer = 0 } = {}) => {
  session = await cashSessionsService.open(
    { opening_amount: cash },
    { id: admin.id, role: admin.role },
  );
  if (transfer > 0) {
    const r = await post(`/api/cash-sessions/${session.id}/manual-incomes`, {
      amount: transfer,
      payment_method: "TRANSFER",
      description: "saldo transfer",
      receipt_reference: "REF-1",
    });
    expect(r.status).toBe(201);
  }
};

const expense = (overrides = {}) =>
  post("/api/expenses", {
    amount: 100,
    description: "gasto qa",
    expense_date: today(),
    payment_method: "CASH",
    category_id: categoryId,
    ...overrides,
  });

const conversion = (overrides = {}) =>
  post("/api/cash-register/conversions", {
    criteria: "DAILY",
    source_method: "CASH",
    amount: 100,
    ...overrides,
  });

beforeEach(async () => {
  admin = await createUserFixture({ role: "ADMIN" });
  const c = await pool.query(
    `INSERT INTO expense_categories (name, active) VALUES ($1, TRUE) RETURNING id`,
    [`qa-${Date.now()}-${Math.random()}`],
  );
  categoryId = c.rows[0].id;
});

describe("#116 · gasto TRANSFER contra el saldo en transferencia", () => {
  it("mayor al disponible → 409 INSUFFICIENT_TRANSFER", async () => {
    await openSession({ transfer: 500 });
    const res = await expense({ amount: 800, payment_method: "TRANSFER" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INSUFFICIENT_TRANSFER");
  });

  it("igual al disponible → 201", async () => {
    await openSession({ transfer: 500 });
    const res = await expense({ amount: 500, payment_method: "TRANSFER" });
    expect(res.status).toBe(201);
  });

  it("No romper: gasto CASH mayor al efectivo sigue en 409, ahora con code INSUFFICIENT_CASH", async () => {
    await openSession({ cash: 100 });
    const res = await expense({ amount: 200, payment_method: "CASH" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INSUFFICIENT_CASH");
  });
});

describe("#117 · conversión DAILY contra el saldo del medio de origen", () => {
  it("efectivo mayor al disponible → 409 INSUFFICIENT_CASH", async () => {
    await openSession({ cash: 100 });
    const res = await conversion({ amount: 1000 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INSUFFICIENT_CASH");
  });

  it("transferencia sin saldo → 409 INSUFFICIENT_TRANSFER", async () => {
    await openSession({ cash: 100 });
    const res = await conversion({ source_method: "TRANSFER", amount: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INSUFFICIENT_TRANSFER");
  });

  it("monto exacto → 201 y el saldo se mueve de medio", async () => {
    await openSession({ cash: 100 });
    expect((await conversion({ amount: 100 })).status).toBe(201);
    // Ahora el efectivo es 0 y la transferencia 100.
    expect((await conversion({ amount: 1 })).status).toBe(409);
    expect((await conversion({ source_method: "TRANSFER", amount: 100 })).status).toBe(201);
  });
});

describe("#118 · montos fuera de rango → 400", () => {
  it("ingreso manual, retiro, conversión y apertura rechazan montos enormes", async () => {
    await openSession({ cash: 100 });
    const acc = await cashAccountsQueries.findGeneralCashAccount();
    const cases = [
      post(`/api/cash-sessions/${session.id}/manual-incomes`, {
        amount: BIG, payment_method: "CASH", description: "qa big",
      }),
      post(`/api/cash-sessions/${session.id}/manual-incomes`, {
        amount: 1e20, payment_method: "CASH", description: "qa big",
      }),
      post(`/api/cash-sessions/${session.id}/drops`, { amount: BIG, payment_method: "CASH" }),
      conversion({ amount: BIG }),
      post("/api/cash-sessions", { opening_amount: BIG }),
      post(`/api/cash-accounts/${acc.id}/movements`, {
        movement_type: "MANUAL_INCOME", amount: BIG, payment_method: "CASH",
      }),
    ];
    for (const res of await Promise.all(cases)) expect(res.status).toBe(400);
  });

  it("No romper: el tope exacto (99999999) se acepta", async () => {
    await openSession();
    const res = await post(`/api/cash-sessions/${session.id}/manual-incomes`, {
      amount: 99999999, payment_method: "CASH", description: "tope",
    });
    expect(res.status).toBe(201);
  });
});

describe("#119 · fechas de la jornada", () => {
  it("conversión con register_date 2020 se guarda con la fecha de la jornada", async () => {
    await openSession({ cash: 100 });
    const res = await conversion({ amount: 10, register_date: "2020-01-01" });
    expect(res.status).toBe(201);
    const r = await pool.query(
      `SELECT to_char(register_date, 'YYYY-MM-DD') AS d FROM cash_conversions WHERE id = $1`,
      [res.body.data.id],
    );
    expect(r.rows[0].d).toBe(today());
  });

  it.each(["2099-01-01", "2020-01-01"])("gasto con expense_date %s → 400", async (d) => {
    await openSession({ cash: 100 });
    const res = await expense({ amount: 10, expense_date: d });
    expect(res.status).toBe(400);
  });

  it("No romper: gasto con la fecha de hoy → 201 y la conserva", async () => {
    await openSession({ cash: 100 });
    const res = await expense({ amount: 10 });
    expect(res.status).toBe(201);
    const r = await pool.query(
      `SELECT to_char(expense_date, 'YYYY-MM-DD') AS d FROM expenses WHERE id = $1`,
      [res.body.data.id],
    );
    expect(r.rows[0].d).toBe(today());
  });
});
