jest.mock("./collections.queries", () => ({
  findInstallmentsForSheet: jest.fn(),
  create: jest.fn(),
  createDetails: jest.fn(),
  markSheetAsRegenerated: jest.fn(),
  findAll: jest.fn(),
  findActiveByCollectorAndDate: jest.fn(),
  findById: jest.fn(),
  findUnassignedCustomersWithPending: jest.fn(),
  markAsSent: jest.fn(),
}));

jest.mock("../../utils/transaction", () => ({
  withTransaction: jest.fn(),
}));

jest.mock("../../utils/date", () => ({
  localDate: jest.fn(),
}));

const queries = require("./collections.queries");
const { withTransaction } = require("../../utils/transaction");
const { localDate } = require("../../utils/date");
const service = require("./collections.service");

describe("collections.service.generateBatch", () => {
  const client = {
    query: jest
      .fn()
      .mockResolvedValue({ rows: [{ id: "user-row" }], rowCount: 1 }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    localDate.mockReturnValue("2026-06-20");
    withTransaction.mockImplementation(async (callback) => callback(client));
    client.query.mockResolvedValue({ rows: [{ id: "user-row" }], rowCount: 1 });
    queries.findUnassignedCustomersWithPending.mockResolvedValue([
      { customer_id: "cu-1", full_name: "Sin Asignar", pending_count: 2 },
    ]);
    queries.findInstallmentsForSheet.mockResolvedValue([
      { installment_id: "i-1", next_visit_date: null, due_date: "2026-06-20" },
    ]);
    queries.create.mockResolvedValue({ id: "sheet-1" });
    queries.findById.mockResolvedValue({ id: "sheet-1", items: [] });
  });

  // Razón de la mejora: con N requests individuales en paralelo, esta query global
  // (independiente del cobrador) se ejecutaba N veces con el mismo resultado.
  it("consulta findUnassignedCustomersWithPending UNA sola vez para todo el batch, sin importar la cantidad de cobradores", async () => {
    await service.generateBatch(
      {
        collector_ids: ["c-1", "c-2", "c-3"],
        date: "2026-06-21",
        filter: "ALL_PENDING",
      },
      "admin-1",
    );

    expect(queries.findUnassignedCustomersWithPending).toHaveBeenCalledTimes(1);
  });

  it("genera una planilla por cada cobrador, en transacciones independientes", async () => {
    const result = await service.generateBatch(
      {
        collector_ids: ["c-1", "c-2"],
        date: "2026-06-21",
        filter: "ALL_PENDING",
      },
      "admin-1",
    );

    expect(withTransaction).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      collector_id: "c-1",
      sheet: { id: "sheet-1" },
    });
    expect(result.results[1]).toMatchObject({
      collector_id: "c-2",
      sheet: { id: "sheet-1" },
    });
  });

  it("comparte la misma alerta de clientes sin asignar entre todos los resultados", async () => {
    const result = await service.generateBatch(
      {
        collector_ids: ["c-1", "c-2"],
        date: "2026-06-21",
        filter: "ALL_PENDING",
      },
      "admin-1",
    );

    expect(result.results[0].alerts.unassigned_customers).toBe(
      result.results[1].alerts.unassigned_customers,
    );
  });

  it("el fallo de un cobrador no aborta a los demás (404/409 quedan aislados como error en su resultado)", async () => {
    queries.findInstallmentsForSheet
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          installment_id: "i-2",
          next_visit_date: null,
          due_date: "2026-06-21",
        },
      ]);

    const result = await service.generateBatch(
      {
        collector_ids: ["c-sin-cuotas", "c-ok"],
        date: "2026-06-21",
        filter: "ALL_PENDING",
      },
      "admin-1",
    );

    expect(result.results[0]).toMatchObject({
      collector_id: "c-sin-cuotas",
      error: { status: 409 },
    });
    expect(result.results[1]).toMatchObject({
      collector_id: "c-ok",
      sheet: { id: "sheet-1" },
    });
  });

  it("rechaza el batch completo si la fecha es pasada, sin llegar a consultar nada", async () => {
    localDate.mockReturnValue("2026-06-25");

    await expect(
      service.generateBatch(
        { collector_ids: ["c-1"], date: "2026-06-20", filter: "ALL_PENDING" },
        "admin-1",
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(queries.findUnassignedCustomersWithPending).not.toHaveBeenCalled();
  });

  it("respeta skip_if_exists por cobrador dentro del batch", async () => {
    queries.findActiveByCollectorAndDate.mockResolvedValueOnce({
      id: "existing-sheet",
      sheet_date: "2026-06-21",
    });

    const result = await service.generateBatch(
      {
        collector_ids: ["c-1"],
        date: "2026-06-21",
        filter: "ALL_PENDING",
        skip_if_exists: true,
      },
      "admin-1",
    );

    expect(result.results[0]).toMatchObject({
      collector_id: "c-1",
      skipped: true,
      existing_sheet: { id: "existing-sheet" },
    });
    expect(queries.create).not.toHaveBeenCalled();
  });
});
