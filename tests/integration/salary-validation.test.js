// Integración — validación de sueldo semanal (issue #62).
// PUT /api/commissions/salary/:userId con weekly_amount <= 0 violaba el CHECK
// salaries_weekly_amount_check (> 0) y respondía 500. Debe responder 400.

// uuid@13 es ESM-only y jest (CommonJS) no lo carga al importar app.js.
jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));

const request = require("supertest");
const app = require("../../src/app");
const { pool, setupTestSuite } = require("./helpers/db");
const { createUserFixture } = require("./helpers/fixtures");
const { generateInternalToken } = require("../../src/utils/jwt");

setupTestSuite();

const auth = (user) => ({ Authorization: `Bearer ${generateInternalToken(user)}` });

let admin;
let collector;

beforeEach(async () => {
  admin = await createUserFixture({ role: "ADMIN" });
  collector = await createUserFixture({ role: "COLLECTOR" });
});

const putSalary = (weekly_amount) =>
  request(app)
    .put(`/api/commissions/salary/${collector.id}`)
    .set(auth(admin))
    .send({ weekly_amount });

const salaryRows = async () =>
  (await pool.query("SELECT weekly_amount::float8 AS amount FROM salaries WHERE user_id = $1", [collector.id])).rows;

describe("PUT /api/commissions/salary/:userId", () => {
  it.each([0, "0", -50])("weekly_amount %p → 400 con mensaje de validación y sin escribir", async (amount) => {
    const res = await putSalary(amount);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).toMatch(/mayor a 0/);
    expect(await salaryRows()).toEqual([]);
  });

  it("weekly_amount 0 sobre un sueldo existente → 400 y el sueldo no cambia", async () => {
    expect((await putSalary(1000)).status).toBe(200);
    const res = await putSalary(0);
    expect(res.status).toBe(400);
    expect(await salaryRows()).toEqual([{ amount: 1000 }]);
  });

  it("crea y edita un sueldo válido (sin cambios de comportamiento)", async () => {
    const created = await putSalary(1500);
    expect(created.status).toBe(200);
    expect(created.body.data.weekly_amount).toBe(1500);

    const edited = await putSalary("2000.5");
    expect(edited.status).toBe(200);
    expect(edited.body.data.weekly_amount).toBe(2000.5);
    expect(await salaryRows()).toEqual([{ amount: 2000.5 }]);
  });
});
