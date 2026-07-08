// Integración — payments.findAll: concepto clasificado (venta de contado) y
// filtro por fecha (date_from/date_to sobre approved_at).

const { pool, setupTestSuite } = require("./helpers/db");
const {
  createUserFixture,
  createCreditFixture,
  createInstallmentFixture,
} = require("./helpers/fixtures");
const paymentsQueries = require("../../src/modules/payments/payments.queries");

setupTestSuite();

// Inserta un cobro APPROVED sobre un crédito del tipo/condición indicados.
const seedCobro = async ({ type, condition, approvedAt }) => {
  const admin = await createUserFixture({ role: "ADMIN" });
  const credit = await createCreditFixture({ type, status: "ACTIVE" });
  await pool.query(`UPDATE credits SET payment_condition = $1 WHERE id = $2`, [
    condition,
    credit.id,
  ]);
  const inst = await createInstallmentFixture({
    credit_id: credit.id,
    original_amount: 1000,
    amount_paid: 0,
    status: "PENDING",
  });
  const r = await pool.query(
    `INSERT INTO payments
       (installment_id, collector_id, amount_received, amount_cash, amount_transfer,
        payment_method, status, is_reversal, approved_by, approved_at, cash_session_id)
     VALUES ($1, $2, 1000, 1000, 0, 'CASH', 'APPROVED', FALSE, $2, $3, NULL)
     RETURNING id`,
    [inst.id, admin.id, approvedAt],
  );
  return r.rows[0].id;
};

describe("payments.findAll — concepto de venta de contado", () => {
  it("clasifica venta de contado y cobro normal", async () => {
    const contado = await seedCobro({
      type: "SALE",
      condition: "CASH",
      approvedAt: "2026-05-10",
    });
    const normal = await seedCobro({
      type: "LOAN",
      condition: "FINANCED",
      approvedAt: "2026-05-10",
    });

    const rows = await paymentsQueries.findAll({});
    const by = Object.fromEntries(rows.map((r) => [r.id, r.concepto]));

    expect(by[contado]).toBe("Venta de contado");
    expect(by[normal]).toBe("Cobro de cuota");
  });
});

describe("payments.findAll — filtro por fecha (approved_at)", () => {
  it("date_from/date_to acota por fecha de aprobación", async () => {
    const enero = await seedCobro({
      type: "LOAN",
      condition: "FINANCED",
      approvedAt: "2026-01-15",
    });
    const marzo = await seedCobro({
      type: "LOAN",
      condition: "FINANCED",
      approvedAt: "2026-03-15",
    });

    const rows = await paymentsQueries.findAll({
      date_from: "2026-03-01",
      date_to: "2026-03-31",
    });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(marzo);
    expect(ids).not.toContain(enero);
  });
});
