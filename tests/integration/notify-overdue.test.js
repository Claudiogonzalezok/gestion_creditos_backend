// Integración — aviso de mora al cliente (issue #88).
//   · POST /api/installments/:id/notify-overdue registra el aviso y envía email.
//   · Idempotente por cuota y día. Cobradores solo sobre clientes asignados.
//   · Falla cerrado sin transporte (503) y sin email del cliente (422).

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
const { daysAgo, today } = require("./helpers/dates");
const { generateInternalToken } = require("../../src/utils/jwt");
const notifier = require("../../src/modules/notifications/notifier");

setupTestSuite();

const auth = (user) => ({ Authorization: `Bearer ${generateInternalToken(user)}` });
const notify = (id, user) => request(app).post(`/api/installments/${id}/notify-overdue`).set(auth(user));

const savedTransport = process.env.NOTIFIER_TRANSPORT;
beforeEach(() => {
  notifier.clearOutbox();
  delete process.env.NOTIFIER_TRANSPORT;
});
afterAll(() => {
  if (savedTransport === undefined) delete process.env.NOTIFIER_TRANSPORT;
  else process.env.NOTIFIER_TRANSPORT = savedTransport;
});

/** Cuota OVERDUE de un cliente con email, opcionalmente asignado a un cobrador. */
const overdueInstallment = async ({ email = "cliente@mail.com", collectorId = null, status = "OVERDUE" } = {}) => {
  const customer = await createCustomerFixture({ email });
  if (collectorId) {
    await pool.query(`UPDATE customers SET assigned_collector_id = $1 WHERE id = $2`, [collectorId, customer.id]);
  }
  const credit = await createCreditFixture({ customer_id: customer.id });
  const inst = await createInstallmentFixture({
    credit_id: credit.id,
    due_date: daysAgo(10),
    status,
    original_amount: 1500,
    amount_paid: 500,
  });
  return { customer, inst };
};

const countNotices = async () =>
  (await pool.query(`SELECT COUNT(*)::int AS n FROM customer_overdue_notices`)).rows[0].n;

describe("POST /api/installments/:id/notify-overdue", () => {
  it("ADMIN: envía el email, registra el aviso y responde 201", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const { customer, inst } = await overdueInstallment();

    const res = await notify(inst.id, admin);
    expect(res.status).toBe(201);
    expect(res.body.data.already_notified).toBe(false);
    expect(res.body.data.notice).toMatchObject({
      installment_id: inst.id,
      customer_id: customer.id,
      channel: "EMAIL",
      recipient: "cliente@mail.com",
      amount_due: 1000,
      sent_by: admin.id,
      notified_on: today(),
    });
    expect(notifier.outbox).toHaveLength(1);
    expect(notifier.outbox[0].to).toBe("cliente@mail.com");
    expect(notifier.outbox[0].text).toContain("cuota 1");
    expect(await countNotices()).toBe(1);
  });

  it("es idempotente por cuota y día: el segundo pedido no reenvía (200)", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const { inst } = await overdueInstallment();
    const first = await notify(inst.id, admin);
    const second = await notify(inst.id, admin);
    expect(second.status).toBe(200);
    expect(second.body.data.already_notified).toBe(true);
    expect(second.body.data.notice.id).toBe(first.body.data.notice.id);
    expect(notifier.outbox).toHaveLength(1);
    expect(await countNotices()).toBe(1);
  });

  it("pedidos concurrentes envían un solo aviso", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const { inst } = await overdueInstallment();
    const results = await Promise.all([notify(inst.id, admin), notify(inst.id, admin), notify(inst.id, admin)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(notifier.outbox).toHaveLength(1);
    expect(await countNotices()).toBe(1);
  });

  it("COLLECTOR: puede avisar a su cliente asignado y no a otros (403)", async () => {
    const collector = await createUserFixture({ role: "COLLECTOR" });
    const other = await createUserFixture({ role: "SELLER_COLLECTOR" });
    const { inst } = await overdueInstallment({ collectorId: collector.id });

    expect((await notify(inst.id, other)).status).toBe(403);
    expect(await countNotices()).toBe(0);
    expect((await notify(inst.id, collector)).status).toBe(201);
  });

  it("SELLER no tiene acceso (403)", async () => {
    const seller = await createUserFixture({ role: "SELLER" });
    const { inst } = await overdueInstallment();
    expect((await notify(inst.id, seller)).status).toBe(403);
  });

  it("cuota que no está en mora → 409 INSTALLMENT_NOT_OVERDUE", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const { inst } = await overdueInstallment({ status: "PENDING" });
    const res = await notify(inst.id, admin);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INSTALLMENT_NOT_OVERDUE");
    expect(notifier.outbox).toHaveLength(0);
  });

  it("cliente sin email → 422 CUSTOMER_NO_EMAIL sin registrar", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const { inst } = await overdueInstallment({ email: null });
    const res = await notify(inst.id, admin);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("CUSTOMER_NO_EMAIL");
    expect(await countNotices()).toBe(0);
  });

  it("cuota inexistente → 404; id inválido → 400", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    expect((await notify(require("crypto").randomUUID(), admin)).status).toBe(404);
    expect((await notify("no-uuid", admin)).status).toBe(400);
  });

  it("sin transporte → 503 NOTIFIER_NOT_CONFIGURED sin registrar", async () => {
    process.env.NOTIFIER_TRANSPORT = "disabled";
    const admin = await createUserFixture({ role: "ADMIN" });
    const { inst } = await overdueInstallment();
    const res = await notify(inst.id, admin);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("NOTIFIER_NOT_CONFIGURED");
    expect(await countNotices()).toBe(0);
  });

  it("si el envío falla no queda registro y se puede reintentar", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const { inst } = await overdueInstallment();
    notifier.setTransport({ send: jest.fn().mockRejectedValue(new Error("smtp caído")) });
    try {
      const res = await notify(inst.id, admin);
      expect(res.status).toBe(500);
      expect(await countNotices()).toBe(0);
    } finally {
      notifier.setTransport(null);
    }
    expect((await notify(inst.id, admin)).status).toBe(201);
  });
});
