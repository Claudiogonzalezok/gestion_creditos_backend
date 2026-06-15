// Integración — Cambio de plan (Etapa 2, ejecución) contra Postgres real.
//
// Valida lo que los unit tests (mocks) no pueden: el SQL real, la migración 033
// y —crítico— que las cuotas PLAN_CHANGE_CANCELLED queden EXCLUIDAS del saldo
// pendiente (getTotalPendingBalance), que es el riesgo principal de la feature.

const { pool, setupTestSuite } = require("./helpers/db");
const {
  createUserFixture,
  createCreditFixture,
  createInstallmentFixture,
} = require("./helpers/fixtures");
const creditsService = require("../../src/modules/credits/credits.service");
const paymentsQueries = require("../../src/modules/payments/payments.queries");
const { today } = require("./helpers/dates");

setupTestSuite();

// Crea un crédito LOAN ACTIVE de 6 cuotas (100000 capital, 20%) con `paid`
// cuotas pagadas (20000 c/u). Inserta la tasa del plan destino (3 cuotas, 10%).
const setupCredit = async ({ paid = 2 } = {}) => {
  const credit = await createCreditFixture({
    type: "LOAN",
    total_amount: 100000,
    installments_count: 6,
    payment_frequency: "MONTHLY",
    interest_rate: 0.2,
    status: "ACTIVE",
  });
  const installments = [];
  for (let n = 1; n <= 6; n++) {
    installments.push(
      await createInstallmentFixture({
        credit_id: credit.id,
        installment_number: n,
        due_date: today(),
        payment_frequency: "MONTHLY",
        original_amount: 20000,
        amount_paid: n <= paid ? 20000 : 0,
        status: n <= paid ? "PAID" : "PENDING",
      }),
    );
  }
  // Tasa para el plan destino = paid + 1 cuotas. interest_rates NO se trunca
  // entre tests (es data de referencia), así que limpiamos el combo antes.
  await pool.query(
    `DELETE FROM interest_rates WHERE payment_frequency='MONTHLY' AND installments_count = $1`,
    [paid + 1],
  );
  await pool.query(
    `INSERT INTO interest_rates (payment_frequency, installments_count, min_amount, max_amount, rate, active)
     VALUES ('MONTHLY', $1, 0, 200000, 0.10, TRUE)`,
    [paid + 1],
  );
  return { credit, installments };
};

describe("changePlan — ejecución contra DB", () => {
  it("deja una cuota viva con el saldo recalculado y anula las futuras", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const { credit, installments } = await setupCredit({ paid: 2 });

    const r = await creditsService.changePlan(
      credit.id,
      { reason: "Cliente pidió plan más corto" },
      admin.id,
    );

    expect(r.newBalance).toBe(70000);
    expect(r.creditWillBeSettled).toBe(false);

    // RIESGO #1: el saldo pendiente ahora es SOLO la cuota sobreviviente (70000).
    // Si las cuotas anuladas no estuvieran excluidas, daría mucho más.
    const pending = await paymentsQueries.getTotalPendingBalance(credit.id);
    expect(pending).toBe(70000);

    // Cuota sobreviviente (#3): saldo = 70000, conserva due_date.
    const surviving = await pool.query(
      `SELECT amount_due::float8, amount_paid::float8, status FROM installments WHERE id = $1`,
      [installments[2].id],
    );
    expect(surviving.rows[0].amount_due - surviving.rows[0].amount_paid).toBe(70000);

    // Cuotas 4,5,6 anuladas con el estado propio.
    const cancelled = await pool.query(
      `SELECT status FROM installments WHERE credit_id = $1 AND installment_number > 3`,
      [credit.id],
    );
    expect(cancelled.rows.every((x) => x.status === "PLAN_CHANGE_CANCELLED")).toBe(true);

    // Cuotas pagadas intactas.
    const paid = await pool.query(
      `SELECT status, amount_paid::float8 FROM installments WHERE credit_id = $1 AND installment_number <= 2`,
      [credit.id],
    );
    expect(paid.rows.every((x) => x.status === "PAID" && x.amount_paid === 20000)).toBe(true);

    // Crédito sigue ACTIVE y su plan vigente refleja el nuevo (3 cuotas, 10%).
    const c = await pool.query(
      `SELECT status, installments_count, interest_rate::float8 FROM credits WHERE id = $1`,
      [credit.id],
    );
    expect(c.rows[0].status).toBe("ACTIVE");
    expect(c.rows[0].installments_count).toBe(3);
    expect(c.rows[0].interest_rate).toBe(0.1);
    const audit = await pool.query(
      `SELECT new_balance::float8, credit_cancelled FROM credit_plan_changes WHERE credit_id = $1`,
      [credit.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].new_balance).toBe(70000);
    expect(audit.rows[0].credit_cancelled).toBe(false);
  });

  it("saldo ≤ 0: cancela el crédito y deja saldo pendiente en 0", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    // 5 pagadas (100000) de 6; plan destino 6 no es más corto → usamos otro caso:
    // forzamos tasa 0% en el plan destino para que el saldo dé 0.
    const credit = await createCreditFixture({
      type: "LOAN",
      total_amount: 100000,
      installments_count: 6,
      payment_frequency: "MONTHLY",
      interest_rate: 0.2,
      status: "ACTIVE",
    });
    for (let n = 1; n <= 6; n++) {
      await createInstallmentFixture({
        credit_id: credit.id,
        installment_number: n,
        due_date: today(),
        payment_frequency: "MONTHLY",
        original_amount: 30000,
        amount_paid: n <= 4 ? 30000 : 0, // pagó 120000 en 4 cuotas
        status: n <= 4 ? "PAID" : "PENDING",
      });
    }
    // plan destino = 5 cuotas, tasa 10% → nuevo_total 110000 − pagado 120000 = -10000 (≤ 0)
    await pool.query(
      `DELETE FROM interest_rates WHERE payment_frequency='MONTHLY' AND installments_count = 5`,
    );
    await pool.query(
      `INSERT INTO interest_rates (payment_frequency, installments_count, min_amount, max_amount, rate, active)
       VALUES ('MONTHLY', 5, 0, 200000, 0.10, TRUE)`,
    );

    const r = await creditsService.changePlan(credit.id, {}, admin.id);

    expect(r.creditWillBeSettled).toBe(true);
    expect(r.newBalance).toBe(-10000);

    const c = await pool.query(
      `SELECT status, settlement_type FROM credits WHERE id = $1`,
      [credit.id],
    );
    expect(c.rows[0].status).toBe("SETTLED");
    expect(c.rows[0].settlement_type).toBe("PLAN_CHANGE");

    const pending = await paymentsQueries.getTotalPendingBalance(credit.id);
    expect(pending).toBe(0);
  });
});
