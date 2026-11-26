// P32 (#46) — reportes.getCollectorsReport
// Con un pago rechazado y una reversión reales, el reporte de cobradores debe
// contar rechazos, calcular la tasa de aprobación real y netear la reversión
// igual que el reporte de cobranzas.

const { pool, setupTestSuite } = require("./helpers/db");
const {
  createUserFixture,
  createPendingPaymentFixture,
} = require("./helpers/fixtures");
const { today } = require("./helpers/dates");
const reportsQueries = require("../../src/modules/reports/reports.queries");

setupTestSuite();

const approve = (id) =>
  pool.query(
    `UPDATE payments SET status = 'APPROVED', approved_at = NOW() WHERE id = $1`,
    [id],
  );

describe("P32 #46 — getCollectorsReport", () => {
  it("cuenta rechazos, tasa real y netea reversiones como getCollectionReport", async () => {
    const collector = await createUserFixture({ role: "COLLECTOR" });
    const base = { collector_id: collector.id };

    const ok = await createPendingPaymentFixture({ ...base, amount_received: 1000 });
    await approve(ok.id);

    const rejected = await createPendingPaymentFixture({ ...base, amount_received: 500 });
    await pool.query(
      `UPDATE payments SET status = 'REJECTED', approved_at = NOW() WHERE id = $1`,
      [rejected.id],
    );

    const reversedOriginal = await createPendingPaymentFixture({
      ...base,
      amount_received: 300,
    });
    await approve(reversedOriginal.id);
    const reversal = await createPendingPaymentFixture({
      ...base,
      installment_id: reversedOriginal.installment_id,
      amount_received: 300,
    });
    await pool.query(
      `UPDATE payments
          SET status = 'APPROVED', approved_at = NOW(),
              is_reversal = TRUE, reversed_by_payment_id = $2
        WHERE id = $1`,
      [reversal.id, reversedOriginal.id],
    );

    // Demora de aprobación: los cobros aprobados tardan 2h; el rechazo y la
    // reversión tardan mucho más y NO deben entrar en avg_approval_hours.
    await pool.query(
      `UPDATE payments SET created_at = approved_at - INTERVAL '2 hours'
        WHERE id = ANY($1::uuid[])`,
      [[ok.id, reversedOriginal.id]],
    );
    await pool.query(
      `UPDATE payments SET created_at = approved_at - INTERVAL '10 hours'
        WHERE id = ANY($1::uuid[])`,
      [[rejected.id, reversal.id]],
    );

    const rows = await reportsQueries.getCollectorsReport(today(), today());
    const row = rows.find((r) => r.collector_id === collector.id);

    expect(row.avg_approval_hours).toBeCloseTo(2, 2);
    expect(row.total_payments).toBe(3);
    expect(row.approved_count).toBe(2);
    expect(row.rejected_count).toBe(1);
    expect(row.approval_rate).toBeCloseTo(66.67, 2);
    expect(row.total_collected).toBeCloseTo(1000, 2);

    const collection = await reportsQueries.getCollectionReport(today(), today());
    const collectedTotal = collection.daily.reduce((a, d) => a + Number(d.total), 0);
    expect(row.total_collected).toBeCloseTo(collectedTotal, 2);
  });

  it("un cobrador sin pagos en el rango sigue apareciendo con métricas en cero", async () => {
    const collector = await createUserFixture({ role: "COLLECTOR" });
    const rows = await reportsQueries.getCollectorsReport(today(), today());
    const row = rows.find((r) => r.collector_id === collector.id);
    expect(row).toMatchObject({
      total_payments: 0,
      approved_count: 0,
      rejected_count: 0,
      total_collected: 0,
      approval_rate: 0,
    });
  });
});
