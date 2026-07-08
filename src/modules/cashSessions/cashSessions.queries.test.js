jest.mock("../../config/db", () => ({ query: jest.fn() }));

const queries = require("./cashSessions.queries");

describe("cashSessions.queries.computeSessionTotals", () => {
  it("suma DOWN_PAYMENT y PREPAID_INSTALLMENT en los ingresos por adelantado del crédito", async () => {
    // db inyectable: cada query devuelve filas vacías; solo interesa el SQL emitido.
    const db = { query: jest.fn().mockResolvedValue({ rows: [{}] }) };

    await queries.computeSessionTotals("cs-1", db);

    const sqls = db.query.mock.calls.map((c) => c[0]);
    const downPaySql = sqls.find((s) => s.includes("credit_down_payments"));

    expect(downPaySql).toBeDefined();
    // Regresión GAP #1: las cuotas pre-pagadas al aprobar un crédito (dinero real
    // recibido) deben entrar en los totales de caja, no solo el enganche.
    expect(downPaySql).toContain("'DOWN_PAYMENT'");
    expect(downPaySql).toContain("'PREPAID_INSTALLMENT'");
  });
});
