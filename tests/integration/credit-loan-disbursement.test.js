// Integración — egreso del préstamo (LOAN) en caja (rama DAILY).
//
// Antes de este cambio, aprobar un LOAN generaba cuotas pero no registraba en
// ninguna caja la salida de efectivo entregada al cliente. Cubre contra
// Postgres real:
//   · el desembolso descuenta el efectivo disponible de la caja activa.
//   · sin caja abierta, la aprobación se rechaza y no muta nada.
//   · si el préstamo supera el efectivo disponible, se rechaza y no muta nada.

const { pool, setupTestSuite } = require("./helpers/db");
const {
  createUserFixture,
  createCreditFixture,
} = require("./helpers/fixtures");
const cashSessionsService = require("../../src/modules/cashSessions/cashSessions.service");
const cashSessionsQueries = require("../../src/modules/cashSessions/cashSessions.queries");
const creditsService = require("../../src/modules/credits/credits.service");

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

// interest_rates es data de referencia, no se trunca entre tests — se limpia
// el combo puntual antes de insertar para no chocar con otros tests.
const ensureRate = async ({ frequency, installments, rate }) => {
  await pool.query(
    `DELETE FROM interest_rates WHERE payment_frequency=$1 AND installments_count=$2`,
    [frequency, installments],
  );
  await pool.query(
    `INSERT INTO interest_rates (payment_frequency, installments_count, min_amount, max_amount, rate, active)
     VALUES ($1, $2, 0, 999999999, $3, TRUE)`,
    [frequency, installments, rate],
  );
};

const pendingLoan = (overrides = {}) =>
  createCreditFixture({
    type: "LOAN",
    status: "PENDING_APPROVAL",
    total_amount: 40000,
    installments_count: 2,
    payment_frequency: "WEEKLY",
    approved_at: null,
    ...overrides,
  });

describe("Caja — egreso del préstamo (LOAN) al aprobar", () => {
  it("descuenta el efectivo disponible de la caja activa y guarda la sesión que lo desembolsó", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    await ensureRate({ frequency: "WEEKLY", installments: 2, rate: 0.1 });
    const credit = await pendingLoan();
    const session = await cashSessionsService.open(
      { opening_amount: 50000 },
      asUser(admin),
    );

    const approved = await creditsService.approve(credit.id, admin.id);

    expect(approved.status).toBe("ACTIVE");

    const row = await pool.query(
      `SELECT disbursement_cash_session_id FROM credits WHERE id = $1`,
      [credit.id],
    );
    expect(row.rows[0].disbursement_cash_session_id).toBe(session.id);

    const totals = await cashSessionsQueries.computeSessionTotals(session.id);
    expect(totals.outflows_loans_cash).toBe(40000);

    const installments = await pool.query(
      `SELECT COUNT(*)::int AS n FROM installments WHERE credit_id = $1`,
      [credit.id],
    );
    expect(installments.rows[0].n).toBe(2);
  });

  it("el cierre de caja refleja el egreso del préstamo (no queda como sobrante)", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    await ensureRate({ frequency: "WEEKLY", installments: 2, rate: 0.1 });
    const credit = await pendingLoan();
    const session = await cashSessionsService.open(
      { opening_amount: 50000 },
      asUser(admin),
    );

    await creditsService.approve(credit.id, admin.id);

    // Efectivo esperado en caja: 50000 abiertos - 40000 desembolsados = 10000.
    await cashSessionsService.close(
      session.id,
      { declared: [{ payment_method: "CASH", declared_amount: 10000 }] },
      asUser(admin),
    );

    const rows = await cashSessionsQueries.findAll({
      businessDayId: session.business_day_id,
    });
    expect(rows[0].closure_difference_status).toBe("EXACT");
  });

  it("rechaza (409 NO_ACTIVE_SESSION) si no hay caja operativa abierta y no muta el crédito", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    await ensureRate({ frequency: "WEEKLY", installments: 2, rate: 0.1 });
    const credit = await pendingLoan();

    await expect(
      creditsService.approve(credit.id, admin.id),
    ).rejects.toMatchObject({ status: 409, code: "NO_ACTIVE_SESSION" });

    const row = await pool.query(`SELECT status FROM credits WHERE id = $1`, [
      credit.id,
    ]);
    expect(row.rows[0].status).toBe("PENDING_APPROVAL");
  });

  it("rechaza (409 INSUFFICIENT_CASH) si el préstamo supera el efectivo disponible y no muta nada", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    await ensureRate({ frequency: "WEEKLY", installments: 2, rate: 0.1 });
    const credit = await pendingLoan({ total_amount: 40000 });
    await cashSessionsService.open({ opening_amount: 10000 }, asUser(admin));

    await expect(
      creditsService.approve(credit.id, admin.id),
    ).rejects.toMatchObject({ status: 409, code: "INSUFFICIENT_CASH" });

    const row = await pool.query(`SELECT status FROM credits WHERE id = $1`, [
      credit.id,
    ]);
    expect(row.rows[0].status).toBe("PENDING_APPROVAL");

    const installments = await pool.query(
      `SELECT COUNT(*)::int AS n FROM installments WHERE credit_id = $1`,
      [credit.id],
    );
    expect(installments.rows[0].n).toBe(0);
  });
});
