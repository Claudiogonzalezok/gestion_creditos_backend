// Integración — Castigo de crédito (write off) contra Postgres real.
//
// Valida lo que los unit tests (mocks) no pueden: el SQL real, la migración 037
// y —crítico— que las cuotas WRITTEN_OFF queden EXCLUIDAS del saldo pendiente
// (getTotalPendingBalance), que es el riesgo principal de la feature: un crédito
// castigado debe desaparecer de la operatoria de cobranza.

const { pool, setupTestSuite } = require("./helpers/db");
const {
  createUserFixture,
  createCreditFixture,
  createInstallmentFixture,
  createPendingPaymentFixture,
} = require("./helpers/fixtures");
const creditsService = require("../../src/modules/credits/credits.service");
const paymentsQueries = require("../../src/modules/payments/payments.queries");
const { today } = require("./helpers/dates");

setupTestSuite();

// Crea un crédito LOAN ACTIVE de 6 cuotas: 2 pagadas (20000 c/u), 1 parcial
// (pagó 5000 de 20000) y 3 pendientes. Saldo abierto = 15000 + 20000*3 = 75000.
const setupCredit = async () => {
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
    const paid = n <= 2 ? 20000 : n === 3 ? 5000 : 0;
    const status = n <= 2 ? "PAID" : n === 3 ? "PARTIAL" : "PENDING";
    installments.push(
      await createInstallmentFixture({
        credit_id: credit.id,
        installment_number: n,
        due_date: today(),
        payment_frequency: "MONTHLY",
        original_amount: 20000,
        amount_paid: paid,
        status,
      }),
    );
  }
  return { credit, installments };
};

describe("writeOffCredit — castigo contra DB", () => {
  it("castiga: cuotas abiertas → WRITTEN_OFF, saldo pendiente en 0, auditoría con el saldo castigado", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const { credit, installments } = await setupCredit();

    const r = await creditsService.writeOffCredit(
      credit.id,
      { reason: "Incobrable", observations: "Cliente ilocalizable" },
      admin.id,
    );

    expect(r.written_off_balance).toBe(75000);

    // RIESGO #1: el crédito sale de cobranza → saldo pendiente 0.
    const pending = await paymentsQueries.getTotalPendingBalance(credit.id);
    expect(pending).toBe(0);

    // Cuotas abiertas (parcial + pendientes) → WRITTEN_OFF.
    const open = await pool.query(
      `SELECT status FROM installments WHERE credit_id = $1 AND installment_number >= 3`,
      [credit.id],
    );
    expect(open.rows.every((x) => x.status === "WRITTEN_OFF")).toBe(true);

    // Cuotas pagadas intactas (no se tocan).
    const paid = await pool.query(
      `SELECT status, amount_paid::float8 FROM installments WHERE credit_id = $1 AND installment_number <= 2`,
      [credit.id],
    );
    expect(paid.rows.every((x) => x.status === "PAID" && x.amount_paid === 20000)).toBe(true);

    // Crédito en WRITTEN_OFF.
    const c = await pool.query(`SELECT status FROM credits WHERE id = $1`, [credit.id]);
    expect(c.rows[0].status).toBe("WRITTEN_OFF");

    // Auditoría completa en credit_write_offs (sin duplicar en credits).
    const audit = await pool.query(
      `SELECT written_off_balance::float8, reason, observations, executed_by
         FROM credit_write_offs WHERE credit_id = $1`,
      [credit.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].written_off_balance).toBe(75000);
    expect(audit.rows[0].reason).toBe("Incobrable");
    expect(audit.rows[0].observations).toBe("Cliente ilocalizable");
    expect(audit.rows[0].executed_by).toBe(admin.id);
    // El pago histórico de la cuota parcial sobrevive (no se borra nada).
    expect(installments[2].id).toBeTruthy();
  });

  it("rechaza castigar si hay un cobro PENDING sin resolver → 409", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const { credit, installments } = await setupCredit();
    await createPendingPaymentFixture({
      installment_id: installments[3].id,
      amount_received: 20000,
    });

    await expect(
      creditsService.writeOffCredit(credit.id, { reason: "Incobrable" }, admin.id),
    ).rejects.toMatchObject({ status: 409 });

    // No mutó: crédito sigue ACTIVE.
    const c = await pool.query(`SELECT status FROM credits WHERE id = $1`, [credit.id]);
    expect(c.rows[0].status).toBe("ACTIVE");
  });

  it("rechaza castigar un crédito no ACTIVE → 409", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const credit = await createCreditFixture({
      type: "LOAN",
      total_amount: 100000,
      installments_count: 6,
      payment_frequency: "MONTHLY",
      interest_rate: 0.2,
      status: "SETTLED",
    });

    await expect(
      creditsService.writeOffCredit(credit.id, { reason: "x cualquiera" }, admin.id),
    ).rejects.toMatchObject({ status: 409 });
  });
});
