// Integración — datos y tasas de la empresa (issue #88).
//   · GET/PUT /api/company y PUT /api/company/rates solo ADMIN.
//   · Las tasas se guardan en system_config (mora/comisión/gracia reusan las
//     claves de negocio) y la actualización es atómica.

jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));

const request = require("supertest");
const app = require("../../src/app");
const { pool, setupTestSuite } = require("./helpers/db");
const { createUserFixture } = require("./helpers/fixtures");
const { generateInternalToken } = require("../../src/utils/jwt");

setupTestSuite();

const auth = (user) => ({ Authorization: `Bearer ${generateInternalToken(user)}` });

// company_settings no se trunca entre tests: se restaura a mano.
beforeEach(async () => {
  await pool.query(
    `UPDATE company_settings
     SET system_name = 'FinFlow', contact_email = NULL, phone = NULL, address = NULL, updated_by = NULL
     WHERE id = 1`,
  );
});

describe("GET /api/company", () => {
  it("devuelve datos y tasas al ADMIN", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const res = await request(app).get("/api/company").set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.company).toMatchObject({ system_name: "FinFlow", contact_email: null });
    expect(res.body.data.rates).toEqual({
      sale_rate_monthly: 0,
      loan_rate_monthly: 0,
      mora_rate_daily: 0,
      seller_commission_rate: 0.08,
      grace_period_days: 3,
    });
  });

  it.each(["SELLER", "COLLECTOR", "SELLER_COLLECTOR"])("rechaza a %s con 403", async (role) => {
    const user = await createUserFixture({ role });
    const res = await request(app).get("/api/company").set(auth(user));
    expect(res.status).toBe(403);
  });

  it("rechaza sin token con 401", async () => {
    const res = await request(app).get("/api/company");
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/company", () => {
  it("actualiza parcialmente y vacía campos con null o \"\"", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    let res = await request(app)
      .put("/api/company")
      .set(auth(admin))
      .send({ system_name: "Mi Empresa", contact_email: "info@empresa.com", phone: "381000" });
    expect(res.status).toBe(200);
    expect(res.body.data.company).toMatchObject({
      system_name: "Mi Empresa",
      contact_email: "info@empresa.com",
      phone: "381000",
      address: null,
      updated_by: admin.id,
    });

    res = await request(app).put("/api/company").set(auth(admin)).send({ phone: "", contact_email: null });
    expect(res.status).toBe(200);
    expect(res.body.data.company).toMatchObject({ system_name: "Mi Empresa", phone: null, contact_email: null });

    const db = await pool.query(`SELECT system_name, phone FROM company_settings WHERE id = 1`);
    expect(db.rows[0]).toEqual({ system_name: "Mi Empresa", phone: null });
  });

  it("valida email, nombre vacío y body sin campos", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    for (const body of [{ contact_email: "no-es-email" }, { system_name: "  " }, {}]) {
      const res = await request(app).put("/api/company").set(auth(admin)).send(body);
      expect(res.status).toBe(400);
    }
    const db = await pool.query(`SELECT system_name, contact_email FROM company_settings WHERE id = 1`);
    expect(db.rows[0]).toEqual({ system_name: "FinFlow", contact_email: null });
  });

  it("rechaza a SELLER con 403 sin modificar", async () => {
    const seller = await createUserFixture({ role: "SELLER" });
    const res = await request(app).put("/api/company").set(auth(seller)).send({ system_name: "X" });
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/company/rates", () => {
  it("guarda las tasas en system_config y las devuelve", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const res = await request(app).put("/api/company/rates").set(auth(admin)).send({
      sale_rate_monthly: 0.12,
      loan_rate_monthly: "0.15",
      mora_rate_daily: 0.005,
      seller_commission_rate: 0.1,
      grace_period_days: 5,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.rates).toEqual({
      sale_rate_monthly: 0.12,
      loan_rate_monthly: 0.15,
      mora_rate_daily: 0.005,
      seller_commission_rate: 0.1,
      grace_period_days: 5,
    });
    const db = await pool.query(
      `SELECT key, value, updated_by FROM system_config
       WHERE key IN ('commission_rate','penalty_grace_days','company_sale_rate_monthly') ORDER BY key`,
    );
    expect(db.rows).toEqual([
      { key: "commission_rate", value: "0.1", updated_by: admin.id },
      { key: "company_sale_rate_monthly", value: "0.12", updated_by: admin.id },
      { key: "penalty_grace_days", value: "5", updated_by: admin.id },
    ]);
  });

  it("es atómica: un valor fuera de rango no guarda ninguno", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const res = await request(app)
      .put("/api/company/rates")
      .set(auth(admin))
      .send({ seller_commission_rate: 0.2, mora_rate_daily: 0.9 });
    expect(res.status).toBe(400);
    const db = await pool.query(`SELECT value FROM system_config WHERE key = 'commission_rate'`);
    expect(db.rows[0].value).toBe("0.08");
  });

  it("rechaza body sin tasas con 400", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const res = await request(app).put("/api/company/rates").set(auth(admin)).send({ foo: 1 });
    expect(res.status).toBe(400);
  });

  it("rechaza a COLLECTOR con 403", async () => {
    const collector = await createUserFixture({ role: "COLLECTOR" });
    const res = await request(app)
      .put("/api/company/rates")
      .set(auth(collector))
      .send({ grace_period_days: 1 });
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/system-config/:key sigue funcionando (regresión)", () => {
  it("actualiza una clave existente con validación numérica", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    let res = await request(app).put("/api/system-config/commission_rate").set(auth(admin)).send({ value: "0.09" });
    expect(res.status).toBe(200);
    expect(res.body.data.value).toBe("0.09");
    res = await request(app).put("/api/system-config/commission_rate").set(auth(admin)).send({ value: "abc" });
    expect(res.status).toBe(400);
  });
});
