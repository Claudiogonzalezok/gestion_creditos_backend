jest.mock("../../config/db", () => ({ query: jest.fn() }));

const pool = require("../../config/db");
const queries = require("./reports.queries");

describe("reports.queries.getCashMovementsReport", () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it("consulta los movimientos filtrando por la caja recibida", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await queries.getCashMovementsReport("cs-1");

    const [sql, params] = pool.query.mock.calls[0];
    expect(params).toEqual(["cs-1"]);
    expect(sql).toContain("WHERE cs.id = $1");
  });

  it("incluye las 5 fuentes de movimientos (cobros, enganches, gastos, drops, conversiones)", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await queries.getCashMovementsReport("cs-1");

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("'COBRO'");
    expect(sql).toContain("'ENGANCHE'");
    expect(sql).toContain("'GASTO'");
    expect(sql).toContain("'DROP'");
    expect(sql).toContain("'CONVERSION'");
    expect(sql).toContain("FROM payments p");
    expect(sql).toContain("FROM credit_down_payments dp");
    expect(sql).toContain("FROM expenses e");
    expect(sql).toContain("FROM cash_session_drops d");
    expect(sql).toContain("FROM cash_conversions cv");
  });

  it("solo toma cobros aprobados imputados a una caja", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await queries.getCashMovementsReport("cs-1");

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain(
      "p.status = 'APPROVED' AND p.cash_session_id IS NOT NULL",
    );
  });

  it("calcula el resumen agregando los montos por tipo de movimiento", async () => {
    pool.query.mockResolvedValue({
      rows: [
        { id: "1", type: "COBRO", amount: 5000 },
        { id: "2", type: "COBRO", amount: 3000 },
        { id: "3", type: "ENGANCHE", amount: 1000 },
        { id: "4", type: "GASTO", amount: 300 },
        { id: "5", type: "DROP", amount: 2000 },
        { id: "6", type: "CONVERSION", amount: 1500 },
      ],
    });

    const result = await queries.getCashMovementsReport("cs-1");

    expect(result.summary).toEqual({
      total_movements: 6,
      total_collections: 8000,
      total_down_payments: 1000,
      total_expenses: 300,
      total_drops: 2000,
    });
    expect(result.rows).toHaveLength(6);
  });

  it("devuelve un resumen en cero cuando la caja no tiene movimientos", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const result = await queries.getCashMovementsReport("cs-1");

    expect(result.summary).toEqual({
      total_movements: 0,
      total_collections: 0,
      total_down_payments: 0,
      total_expenses: 0,
      total_drops: 0,
    });
    expect(result.rows).toEqual([]);
  });
});

describe("reports.queries.getGeneralCashMovementsReport", () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it("consulta cash_account_movements filtrando por Caja General y rango de fechas", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ total_movements: 0, total_in: 0, total_out: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await queries.getGeneralCashMovementsReport("2026-06-01", "2026-06-17");

    const [summarySql, summaryParams] = pool.query.mock.calls[0];
    expect(summaryParams).toEqual(["2026-06-01", "2026-06-17"]);
    expect(summarySql).toContain("FROM cash_account_movements m");
    expect(summarySql).toContain("type = 'GENERAL_CASH'");

    const [detailSql] = pool.query.mock.calls[1];
    expect(detailSql).toContain("LEFT JOIN users u ON u.id = m.created_by");
  });

  it("devuelve summary y rows tal como los entrega la DB", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ total_movements: 2, total_in: 1700, total_out: 1500 }],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: "m-1", movement_type: "MANUAL_INCOME", direction: "IN" },
          { id: "m-2", movement_type: "EXPENSE", direction: "OUT" },
        ],
      });

    const result = await queries.getGeneralCashMovementsReport(
      "2026-06-01",
      "2026-06-17",
    );

    expect(result.summary).toEqual({
      total_movements: 2,
      total_in: 1700,
      total_out: 1500,
    });
    expect(result.rows).toHaveLength(2);
  });
});
