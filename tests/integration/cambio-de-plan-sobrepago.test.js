// P10 — Cambio de plan con sobrepago (issue #45).
// Si el cliente ya pagó más que el total del nuevo plan, el excedente no se
// descarta: la simulación lo informa y la ejecución exige que el cliente elija
// su destino (excess_disposition): saldo a favor o devolución desde caja.
// Además, simulación y ejecución deben anular exactamente las mismas cuotas.

const { pool, setupTestSuite, preserveTable } = require("./helpers/db");
const {
  createUserFixture,
  createCreditFixture,
  createInstallmentFixture,
} = require("./helpers/fixtures");
const { today } = require("./helpers/dates");
const creditsService = require("../../src/modules/credits/credits.service");
const cashSessionsService = require("../../src/modules/cashSessions/cashSessions.service");
const cashSessionsQueries = require("../../src/modules/cashSessions/cashSessions.queries");

preserveTable("interest_rates");
setupTestSuite();

// LOAN 100000 en 6 cuotas de 30000; pagó 4 (120000). Plan destino 5 cuotas al
// 10% → nuevo total 110000 → saldo −10000 (sobrepago de 10000).
const setupOverpaidCredit = async () => {
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
      amount_paid: n <= 4 ? 30000 : 0,
      status: n <= 4 ? "PAID" : "PENDING",
    });
  }
  await pool.query(
    `DELETE FROM interest_rates WHERE payment_frequency='MONTHLY' AND installments_count = 5`,
  );
  await pool.query(
    `INSERT INTO interest_rates (payment_frequency, installments_count, min_amount, max_amount, rate, active)
     VALUES ('MONTHLY', 5, 0, 200000, 0.10, TRUE)`,
  );
  return credit;
};

const creditRow = async (id) =>
  (
    await pool.query(
      `SELECT status, credit_balance::float8 FROM credits WHERE id = $1`,
      [id],
    )
  ).rows[0];

const planChangeRow = async (creditId) =>
  (
    await pool.query(
      `SELECT excess_amount::float8, excess_disposition, refund_cash_session_id
         FROM credit_plan_changes WHERE credit_id = $1`,
      [creditId],
    )
  ).rows;

describe("P10 — cambio de plan con sobrepago (#45)", () => {
  it("la simulación informa el excedente y anula las mismas cuotas que la ejecución", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const credit = await setupOverpaidCredit();

    const sim = await creditsService.simulatePlanChange(credit.id);
    expect(sim.excessAmount).toBe(10000);
    expect(sim.requiresExcessDisposition).toBe(true);

    const exec = await creditsService.changePlan(
      credit.id,
      { excess_disposition: "CREDIT_BALANCE" },
      admin.id,
    );
    expect(exec.cancelledInstallments).toEqual(sim.cancelledInstallments);
    const cancelled = await pool.query(
      `SELECT installment_number FROM installments
        WHERE credit_id = $1 AND status = 'PLAN_CHANGE_CANCELLED' ORDER BY installment_number`,
      [credit.id],
    );
    expect(cancelled.rows.map((r) => r.installment_number)).toEqual(sim.cancelledInstallments);
  });

  it("sin excess_disposition → 422 EXCESS_DISPOSITION_REQUIRED y no muta nada", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const credit = await setupOverpaidCredit();

    await expect(creditsService.changePlan(credit.id, {}, admin.id)).rejects.toMatchObject({
      status: 422,
      code: "EXCESS_DISPOSITION_REQUIRED",
    });
    await expect(
      creditsService.changePlan(credit.id, { excess_disposition: "OTRA" }, admin.id),
    ).rejects.toMatchObject({ status: 422, code: "EXCESS_DISPOSITION_REQUIRED" });

    expect(await creditRow(credit.id)).toEqual({ status: "ACTIVE", credit_balance: 0 });
    expect(await planChangeRow(credit.id)).toEqual([]);
  });

  it("CREDIT_BALANCE → el excedente queda como saldo a favor del crédito", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const credit = await setupOverpaidCredit();

    const r = await creditsService.changePlan(
      credit.id,
      { excess_disposition: "CREDIT_BALANCE" },
      admin.id,
    );
    expect(r).toMatchObject({ excessAmount: 10000, excessDisposition: "CREDIT_BALANCE" });
    expect(await creditRow(credit.id)).toEqual({ status: "SETTLED", credit_balance: 10000 });
    expect(await planChangeRow(credit.id)).toEqual([
      { excess_amount: 10000, excess_disposition: "CREDIT_BALANCE", refund_cash_session_id: null },
    ]);
  });

  it("REFUND sin caja activa → 409 NO_ACTIVE_SESSION y no muta nada", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const credit = await setupOverpaidCredit();

    await expect(
      creditsService.changePlan(credit.id, { excess_disposition: "REFUND" }, admin.id),
    ).rejects.toMatchObject({ status: 409, code: "NO_ACTIVE_SESSION" });
    expect(await creditRow(credit.id)).toEqual({ status: "ACTIVE", credit_balance: 0 });
    expect(await planChangeRow(credit.id)).toEqual([]);
  });

  it("REFUND con caja activa → egreso de efectivo imputado a la caja de la jornada", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const session = await cashSessionsService.open(
      { opening_amount: 50000 },
      { id: admin.id, role: admin.role },
    );
    const credit = await setupOverpaidCredit();
    const before = await cashSessionsQueries.computeSessionTotals(session.id);

    await creditsService.changePlan(credit.id, { excess_disposition: "REFUND" }, admin.id);

    expect(await creditRow(credit.id)).toEqual({ status: "SETTLED", credit_balance: 0 });
    expect(await planChangeRow(credit.id)).toEqual([
      { excess_amount: 10000, excess_disposition: "REFUND", refund_cash_session_id: session.id },
    ]);
    const after = await cashSessionsQueries.computeSessionTotals(session.id);
    expect(after.outflows_plan_change_refunds_cash).toBe(10000);
    expect(after.outflows_loans_cash - before.outflows_loans_cash).toBe(10000);
  });

  it("no rompe: cambio de plan sin sobrepago no exige excess_disposition", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const credit = await setupOverpaidCredit();
    // Tasa 20% → nuevo total 120000 = pagado → saldo 0, sin excedente.
    await pool.query(
      `UPDATE interest_rates SET rate = 0.20 WHERE payment_frequency='MONTHLY' AND installments_count = 5`,
    );

    const sim = await creditsService.simulatePlanChange(credit.id);
    expect(sim).toMatchObject({ excessAmount: 0, requiresExcessDisposition: false });

    const r = await creditsService.changePlan(credit.id, {}, admin.id);
    expect(r.creditWillBeSettled).toBe(true);
    expect(await creditRow(credit.id)).toEqual({ status: "SETTLED", credit_balance: 0 });
  });
});
