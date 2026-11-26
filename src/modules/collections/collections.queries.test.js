jest.mock("../../config/db", () => ({ query: jest.fn() }));

const { collapseToOldestPerCredit, createDetails } = require("./collections.queries");

/** Helper: fila mínima de detalle de planilla con los campos que usa el colapso. */
const row = (o) => ({
  credit_id: "C",
  installment_id: "i",
  installment_number: 1,
  order_number: 1,
  ...o,
});

describe("collapseToOldestPerCredit", () => {
  it("deja UNA cuota por crédito (la más antigua) y cuenta las demás del mismo crédito", () => {
    const out = collapseToOldestPerCredit([
      row({ credit_id: "A", installment_id: "a4", installment_number: 4, order_number: 1 }),
      row({ credit_id: "A", installment_id: "a5", installment_number: 5, order_number: 2 }),
      row({ credit_id: "A", installment_id: "a6", installment_number: 6, order_number: 3 }),
      row({ credit_id: "B", installment_id: "b8", installment_number: 8, order_number: 4 }),
      row({ credit_id: "B", installment_id: "b9", installment_number: 9, order_number: 5 }),
    ]);

    expect(out).toHaveLength(2);
    const a = out.find((r) => r.credit_id === "A");
    const b = out.find((r) => r.credit_id === "B");
    expect(a.installment_id).toBe("a4");
    expect(a.additional_installments_count).toBe(2);
    expect(b.installment_id).toBe("b8");
    expect(b.additional_installments_count).toBe(1);
  });

  it("una sola cuota del crédito → additional_installments_count = 0", () => {
    const out = collapseToOldestPerCredit([
      row({ credit_id: "A", installment_number: 4 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].additional_installments_count).toBe(0);
  });

  it("elige la más antigua sin importar el orden de entrada", () => {
    const out = collapseToOldestPerCredit([
      row({ credit_id: "A", installment_id: "a6", installment_number: 6, order_number: 3 }),
      row({ credit_id: "A", installment_id: "a4", installment_number: 4, order_number: 1 }),
    ]);
    expect(out[0].installment_id).toBe("a4");
    expect(out[0].additional_installments_count).toBe(1);
  });

  it("mantiene el orden final por order_number", () => {
    const out = collapseToOldestPerCredit([
      row({ credit_id: "B", installment_id: "b", installment_number: 8, order_number: 5 }),
      row({ credit_id: "A", installment_id: "a", installment_number: 4, order_number: 1 }),
    ]);
    expect(out.map((r) => r.credit_id)).toEqual(["A", "B"]);
  });

  it("sin credit_id no agrupa (cae a installment_id como clave)", () => {
    const out = collapseToOldestPerCredit([
      row({ credit_id: null, installment_id: "x", installment_number: 1, order_number: 1 }),
      row({ credit_id: null, installment_id: "y", installment_number: 2, order_number: 2 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.additional_installments_count === 0)).toBe(true);
  });
});

describe("createDetails — inserción por lotes (#38)", () => {
  const item = (i) => ({ installment_id: `i${i}`, amount_due: 100, installment_number: 1 });

  it("una planilla grande se inserta en varios INSERT sin superar 65535 parámetros", async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const items = Array.from({ length: 2600 }, (_, i) => item(i));
    await createDetails("S", items, db);
    expect(db.query.mock.calls.length).toBeGreaterThan(1);
    let total = 0;
    for (const [, params] of db.query.mock.calls) {
      expect(params.length).toBeLessThanOrEqual(65535);
      expect(params.length % 26).toBe(0);
      total += params.length / 26;
    }
    expect(total).toBe(2600);
    // order_number (3er parámetro de cada fila) sigue siendo global y correlativo
    const orders = db.query.mock.calls.flatMap(([, params]) =>
      params.filter((_, idx) => idx % 26 === 2));
    expect(orders).toEqual(items.map((_, i) => i + 1));
  });

  it("una planilla chica sigue siendo un único INSERT", async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await createDetails("S", [item(1), item(2)], db);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
