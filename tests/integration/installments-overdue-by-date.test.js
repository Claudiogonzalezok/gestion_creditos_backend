// #89 — Cuotas vencidas por fecha (independiente del status persistido) y
// aplicación de mora manual sobre cuotas vencidas cuyo status sigue en
// PENDING/PARTIAL (por ejemplo, porque el cron todavía no corrió).

// uuid@13 es ESM-only y jest (CommonJS) no lo carga al importar app.js.
jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));
jest.setTimeout(30000);

const request = require("supertest");
const app = require("../../src/app");
const { setupTestSuite } = require("./helpers/db");
const {
  createUserFixture,
  createCreditFixture,
  createInstallmentFixture,
  reloadInstallment,
} = require("./helpers/fixtures");
const { daysAgo, daysFromNow } = require("./helpers/dates");
const { generateInternalToken } = require("../../src/utils/jwt");

setupTestSuite();

const auth = (user) => ({ Authorization: `Bearer ${generateInternalToken(user)}` });

let admin;
beforeEach(async () => {
  admin = await createUserFixture({ role: "ADMIN" });
});

describe("GET /api/installments — filtros overdue / due_before", () => {
  let credit, pendingPast, partialPast, overduePast, paidPast, writtenOff, future;

  beforeEach(async () => {
    credit = await createCreditFixture();
    const c = { credit_id: credit.id };
    pendingPast = await createInstallmentFixture({ ...c, installment_number: 1, due_date: daysAgo(10), status: "PENDING" });
    partialPast = await createInstallmentFixture({ ...c, installment_number: 2, due_date: daysAgo(8), status: "PARTIAL", amount_paid: 300 });
    overduePast = await createInstallmentFixture({ ...c, installment_number: 3, due_date: daysAgo(6), status: "OVERDUE" });
    paidPast    = await createInstallmentFixture({ ...c, installment_number: 4, due_date: daysAgo(5), status: "PAID", amount_paid: 1000 });
    writtenOff  = await createInstallmentFixture({ ...c, installment_number: 5, due_date: daysAgo(4), status: "WRITTEN_OFF" });
    future      = await createInstallmentFixture({ ...c, installment_number: 6, due_date: daysFromNow(5), status: "PENDING" });
  });

  const ids = (res) => res.body.data.map((r) => r.id);

  it("overdue=true lista vencidas con saldo sin importar el status persistido", async () => {
    const res = await request(app).get(`/api/installments?overdue=true&credit_id=${credit.id}`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([pendingPast.id, partialPast.id, overduePast.id]);
    expect(ids(res)).not.toContain(paidPast.id);
    expect(ids(res)).not.toContain(writtenOff.id);
    expect(ids(res)).not.toContain(future.id);
  });

  it("due_before acota por fecha de vencimiento estricta", async () => {
    const res = await request(app).get(`/api/installments?due_before=${daysAgo(7)}&credit_id=${credit.id}`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([pendingPast.id, partialPast.id]);
  });

  it("se combina con status y con paginación", async () => {
    const byStatus = await request(app).get(`/api/installments?overdue=true&status=PENDING&credit_id=${credit.id}`).set(auth(admin));
    expect(ids(byStatus)).toEqual([pendingPast.id]);

    const page = await request(app).get(`/api/installments?overdue=true&credit_id=${credit.id}&limit=1&offset=1`).set(auth(admin));
    expect(page.status).toBe(200);
    expect(ids(page)).toEqual([partialPast.id]);
    expect(page.body.pagination).toEqual({ total: 3, limit: 1, offset: 1 });
  });

  it("overdue=false no filtra (comportamiento previo)", async () => {
    const res = await request(app).get(`/api/installments?overdue=false&credit_id=${credit.id}`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(6);
  });

  it("valida overdue y due_before", async () => {
    const a = await request(app).get("/api/installments?overdue=maybe").set(auth(admin));
    const b = await request(app).get("/api/installments?due_before=2026-13-40").set(auth(admin));
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
  });

  it("el cobrador sigue restringido a sus clientes", async () => {
    const collector = await createUserFixture({ role: "COLLECTOR" });
    const res = await request(app).get(`/api/installments?overdue=true&credit_id=${credit.id}`).set(auth(collector));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe("PATCH /api/installments/:id/apply-penalty — vencidas por fecha", () => {
  const apply = (id, amount = 50) =>
    request(app).patch(`/api/installments/${id}/apply-penalty`).set(auth(admin)).send({ penalty_amount: amount });

  it("aplica mora a una cuota PENDING vencida con saldo", async () => {
    const inst = await createInstallmentFixture({ due_date: daysAgo(5), status: "PENDING" });
    const res = await apply(inst.id);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("OVERDUE");
    const row = await reloadInstallment(inst.id);
    expect(Number(row.penalty_amount)).toBe(50);
    expect(Number(row.amount_due)).toBe(1050);
  });

  it("aplica mora a una cuota PARTIAL vencida con saldo", async () => {
    const inst = await createInstallmentFixture({ due_date: daysAgo(5), status: "PARTIAL", amount_paid: 400 });
    const res = await apply(inst.id);
    expect(res.status).toBe(200);
    expect(Number((await reloadInstallment(inst.id)).penalty_amount)).toBe(50);
  });

  it("sigue aplicando mora a cuotas OVERDUE", async () => {
    const inst = await createInstallmentFixture({ due_date: daysAgo(5), status: "OVERDUE" });
    expect((await apply(inst.id)).status).toBe(200);
  });

  it("rechaza una cuota PENDING que todavía no venció", async () => {
    const inst = await createInstallmentFixture({ due_date: daysFromNow(3), status: "PENDING" });
    const res = await apply(inst.id);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/no está vencida/);
    expect(Number((await reloadInstallment(inst.id)).penalty_amount)).toBe(0);
  });

  it("rechaza una cuota PAID con mensaje claro", async () => {
    const inst = await createInstallmentFixture({ due_date: daysAgo(5), status: "PAID", amount_paid: 1000 });
    const res = await apply(inst.id);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/ya fue pagada/);
    expect(Number((await reloadInstallment(inst.id)).penalty_amount)).toBe(0);
  });
});
