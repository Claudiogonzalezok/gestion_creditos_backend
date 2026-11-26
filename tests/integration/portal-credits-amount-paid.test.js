// Integración — GET /api/portal/credits expone lo pagado (issue #98).
//   · Cada crédito trae installments[] con amount_paid por cuota.
//   · remaining_amount del listado coincide con la deuda del detalle.

jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));

const request = require("supertest");
const app = require("../../src/app");
const { pool, setupTestSuite } = require("./helpers/db");
const {
  createCustomerFixture,
  createCreditFixture,
  createInstallmentFixture,
} = require("./helpers/fixtures");
const { generatePortalToken } = require("../../src/utils/jwt");

setupTestSuite();

/**
 * Cliente con acceso al portal habilitado.
 * @returns {Promise<object>}
 */
const createPortalCustomer = async () => {
  const c = await createCustomerFixture();
  await pool.query(`UPDATE customers SET portal_enabled = TRUE WHERE id = $1`, [c.id]);
  return c;
};

const auth = (customer) => ({ Authorization: `Bearer ${generatePortalToken(customer)}` });

describe("GET /api/portal/credits — amount_paid y remaining_amount", () => {
  it("con un pago parcial, la deuda del listado coincide con la del detalle", async () => {
    const customer = await createPortalCustomer();
    const credit = await createCreditFixture({ customer_id: customer.id, installments_count: 3 });
    await createInstallmentFixture({ credit_id: credit.id, installment_number: 1, original_amount: 1000, amount_paid: 1000, status: "PAID" });
    await createInstallmentFixture({ credit_id: credit.id, installment_number: 2, original_amount: 1000, amount_paid: 400, status: "PARTIAL" });
    await createInstallmentFixture({ credit_id: credit.id, installment_number: 3, original_amount: 1000, amount_paid: 0, status: "PENDING" });

    const list = await request(app).get("/api/portal/credits").set(auth(customer));
    expect(list.status).toBe(200);
    const item = list.body.data.find((c) => c.id === credit.id);
    expect(item.amount_paid).toBe(1400);
    expect(item.remaining_amount).toBe(1600);
    expect(item.installments.map((i) => [i.installment_number, i.amount_paid, i.status])).toEqual([
      [1, 1000, "PAID"],
      [2, 400, "PARTIAL"],
      [3, 0, "PENDING"],
    ]);

    const detail = await request(app).get(`/api/portal/credits/${credit.id}`).set(auth(customer));
    expect(detail.status).toBe(200);
    const detailRemaining = detail.body.data.installments
      .filter((i) => i.status !== "PAID")
      .reduce((s, i) => s + (i.amount_due - i.amount_paid), 0);
    expect(item.remaining_amount).toBe(detailRemaining);
    expect(detail.body.data.remaining_amount).toBe(item.remaining_amount);
    expect(detail.body.data.amount_paid).toBe(item.amount_paid);
  });

  it("crédito saldado devuelve remaining_amount 0", async () => {
    const customer = await createPortalCustomer();
    const credit = await createCreditFixture({ customer_id: customer.id, status: "SETTLED" });
    await createInstallmentFixture({ credit_id: credit.id, original_amount: 500, amount_paid: 500, status: "PAID" });
    const res = await request(app).get("/api/portal/credits").set(auth(customer));
    const item = res.body.data.find((c) => c.id === credit.id);
    expect(item.remaining_amount).toBe(0);
    expect(item.amount_paid).toBe(500);
  });
});
