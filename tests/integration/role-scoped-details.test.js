// Integración — alcance por rol en endpoints de detalle (issue #27, IDOR).
//
// Regla (misma que los listados):
//   · COLLECTOR puro solo ve clientes asignados (customers.assigned_collector_id),
//     y por extensión el detalle y el historial de cobros de créditos de esos
//     clientes. Si no le corresponde → 404 (no 403, para no confirmar el ID).
//   · SELLER / SELLER_COLLECTOR / ADMIN ven toda la cartera (decisión del dueño,
//     commit af1c17d) — se fija que eso no cambie.
//   · Excepción: un COLLECTOR conserva acceso a créditos que figuran en una
//     planilla suya (la planilla es un snapshot inmutable; el cliente pudo ser
//     reasignado después de generarla).
//   · Anular un intento de cobranza: solo quien lo creó (created_by) o ADMIN.

// uuid@13 es ESM-only y jest (CommonJS) no lo carga al importar app.js;
// se reemplaza por crypto.randomUUID, equivalente para v4.
jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));

const request = require("supertest");
const app = require("../../src/app");
const { pool, setupTestSuite } = require("./helpers/db");
const {
  createUserFixture,
  createCustomerFixture,
  createCreditFixture,
  createInstallmentFixture,
} = require("./helpers/fixtures");
const { generateInternalToken } = require("../../src/utils/jwt");

setupTestSuite();

const auth = (user) => ({ Authorization: `Bearer ${generateInternalToken(user)}` });

/** Crea un cliente asignado (o no) a un cobrador, con un crédito y una cuota. */
const seedCustomerWithCredit = async (collectorId) => {
  const customer = await createCustomerFixture();
  if (collectorId) {
    await pool.query(
      "UPDATE customers SET assigned_collector_id = $1 WHERE id = $2",
      [collectorId, customer.id],
    );
  }
  const credit = await createCreditFixture({ customer_id: customer.id });
  const inst = await createInstallmentFixture({ credit_id: credit.id });
  return { customer, credit, inst };
};

let users;
let own;
let foreign;

beforeEach(async () => {
  users = {
    admin: await createUserFixture({ role: "ADMIN" }),
    seller: await createUserFixture({ role: "SELLER" }),
    collector: await createUserFixture({ role: "COLLECTOR" }),
    sellerCollector: await createUserFixture({ role: "SELLER_COLLECTOR" }),
    otherCollector: await createUserFixture({ role: "COLLECTOR" }),
  };
  own = await seedCustomerWithCredit(users.collector.id);
  foreign = await seedCustomerWithCredit(users.otherCollector.id);
});

const endpoints = [
  ["GET /api/customers/:id", (s) => `/api/customers/${s.customer.id}`],
  ["GET /api/credits/:id", (s) => `/api/credits/${s.credit.id}`],
  ["GET /api/credits/:creditId/payments", (s) => `/api/credits/${s.credit.id}/payments`],
];

describe.each(endpoints)("%s — alcance por rol", (_name, url) => {
  it("COLLECTOR recibe 404 sobre un recurso de cliente no asignado", async () => {
    const res = await request(app).get(url(foreign)).set(auth(users.collector));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(foreign.customer.dni);
  });

  it("COLLECTOR ve el recurso de su cliente asignado", async () => {
    const res = await request(app).get(url(own)).set(auth(users.collector));
    expect(res.status).toBe(200);
  });

  it.each(["admin", "seller", "sellerCollector"])(
    "%s sigue viendo recursos de cualquier cliente",
    async (role) => {
      const res = await request(app).get(url(foreign)).set(auth(users[role]));
      expect(res.status).toBe(200);
    },
  );

  it("un ID inexistente da el mismo 404 que uno ajeno", async () => {
    const missing = url({
      customer: { id: "00000000-0000-4000-8000-000000000000" },
      credit: { id: "00000000-0000-4000-8000-000000000000" },
    });
    const res = await request(app).get(missing).set(auth(users.collector));
    expect(res.status).toBe(404);
  });
});

describe("COLLECTOR con el crédito en una planilla propia (cliente reasignado)", () => {
  it("conserva acceso al detalle e historial del crédito de su planilla", async () => {
    const sheet = await pool.query(
      `INSERT INTO collection_sheets (collector_id, sheet_date, generated_by)
       VALUES ($1, CURRENT_DATE, $2) RETURNING id`,
      [users.collector.id, users.admin.id],
    );
    await pool.query(
      `INSERT INTO collection_sheet_details (sheet_id, installment_id, order_number, planned_amount)
       VALUES ($1, $2, 1, 100)`,
      [sheet.rows[0].id, foreign.inst.id],
    );
    for (const path of [
      `/api/credits/${foreign.credit.id}`,
      `/api/credits/${foreign.credit.id}/payments`,
    ]) {
      const res = await request(app).get(path).set(auth(users.collector));
      expect(res.status).toBe(200);
    }
  });
});

describe("PATCH /api/collection-attempts/:id/void — solo el creador o ADMIN", () => {
  const seedAttempt = async (createdBy) => {
    const r = await pool.query(
      `INSERT INTO collection_attempts (installment_id, collector_id, created_by, attempt_type)
       VALUES ($1, $2, $3, 'NO_PAYMENT') RETURNING id`,
      [own.inst.id, users.collector.id, createdBy],
    );
    return r.rows[0].id;
  };

  it("COLLECTOR no puede anular un intento que creó el ADMIN (403)", async () => {
    const id = await seedAttempt(users.admin.id);
    const res = await request(app)
      .patch(`/api/collection-attempts/${id}/void`)
      .set(auth(users.collector));
    expect(res.status).toBe(403);
    const row = await pool.query("SELECT voided_at FROM collection_attempts WHERE id = $1", [id]);
    expect(row.rows[0].voided_at).toBeNull();
  });

  it("COLLECTOR anula su propio intento", async () => {
    const id = await seedAttempt(users.collector.id);
    const res = await request(app)
      .patch(`/api/collection-attempts/${id}/void`)
      .set(auth(users.collector));
    expect(res.status).toBe(200);
  });

  it("ADMIN anula cualquier intento", async () => {
    const id = await seedAttempt(users.collector.id);
    const res = await request(app)
      .patch(`/api/collection-attempts/${id}/void`)
      .set(auth(users.admin));
    expect(res.status).toBe(200);
  });
});
