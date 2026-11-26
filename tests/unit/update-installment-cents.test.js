// P32 (#39): updateInstallment suma amount_paid en centavos antes del UPDATE.
jest.mock("../../src/config/db", () => ({ query: jest.fn() }));

const { updateInstallment } = require("../../src/modules/payments/payments.queries");

const fakeClient = () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ status: "PARTIAL" }] }),
});

describe("payments.queries.updateInstallment (montos exactos)", () => {
  it("0.1 pagado + 0.2 recibido persiste exactamente 0.3", async () => {
    const client = fakeClient();
    await updateInstallment(client, "inst-1", 0.2, 1000, 0.1, 3);
    expect(client.query.mock.calls[0][1][0]).toBe(0.3);
  });

  it("trunca al saldo exacto con montos no representables (1000.07 - 0.01)", async () => {
    const client = fakeClient();
    await updateInstallment(client, "inst-1", 5000, "1000.07", "0.01", 3);
    expect(client.query.mock.calls[0][1][0]).toBe(1000.07);
  });
});
