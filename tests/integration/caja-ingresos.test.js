// Integración — ingresos a caja que antes se perdían (auditoría contable).
//
// Cubre los dos hallazgos corregidos en fix/caja-ingresos-no-contabilizados,
// contra Postgres real:
//   · GAP #1: cuotas pre-pagadas al aprobar un crédito (PREPAID_INSTALLMENT)
//     deben entrar en los totales de caja y el cierre debe cuadrar.
//   · GAP #2: el pago anticipado de cuota (/early-pay) debe imputar el ingreso
//     a la caja activa de la jornada (cash_session_id + total de la sesión).

const { pool, setupTestSuite } = require("./helpers/db");
const {
  createUserFixture,
  createCreditFixture,
  createInstallmentFixture,
} = require("./helpers/fixtures");
const cashSessionsService = require("../../src/modules/cashSessions/cashSessions.service");
const cashSessionsQueries = require("../../src/modules/cashSessions/cashSessions.queries");
const installmentsService = require("../../src/modules/installments/installments.service");
const { today } = require("./helpers/dates");

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

// Inserta un ingreso por adelantado de un crédito (enganche o cuota pre-pagada)
// directo en DB, imputado a la caja indicada — emula lo que hace
// credits.service.approve sin orquestar todo el alta del crédito.
const insertCreditUpfront = async ({
  creditId,
  adminId,
  amount,
  paymentType,
  sessionId,
}) => {
  await pool.query(
    `INSERT INTO credit_down_payments
       (credit_id, amount, payment_method, approved_by, payment_type, register_date, cash_session_id)
     VALUES ($1, $2, 'CASH', $3, $4, $5, $6)`,
    [creditId, amount, adminId, paymentType, today(), sessionId],
  );
};

describe("Caja — ingresos por adelantado del crédito (GAP #1)", () => {
  it("suma enganche + cuotas pre-pagadas en los totales de la caja", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const credit = await createCreditFixture({ total_amount: 10000 });
    const session = await cashSessionsService.open(
      { opening_amount: 0 },
      asUser(admin),
    );

    await insertCreditUpfront({
      creditId: credit.id,
      adminId: admin.id,
      amount: 2000,
      paymentType: "DOWN_PAYMENT",
      sessionId: session.id,
    });
    await insertCreditUpfront({
      creditId: credit.id,
      adminId: admin.id,
      amount: 3000,
      paymentType: "PREPAID_INSTALLMENT",
      sessionId: session.id,
    });

    const totals = await cashSessionsQueries.computeSessionTotals(session.id);

    // Antes del fix solo se contaba el enganche (2000): la cuota pre-pagada
    // quedaba fuera. Ahora deben sumar ambos.
    expect(totals.collections_down_payments_cash).toBe(5000);
  });

  it("el cierre cuadra cuando se pre-pagan cuotas (no aparece sobrante falso)", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const credit = await createCreditFixture({ total_amount: 10000 });
    const session = await cashSessionsService.open(
      { opening_amount: 0 },
      asUser(admin),
    );

    await insertCreditUpfront({
      creditId: credit.id,
      adminId: admin.id,
      amount: 3000,
      paymentType: "PREPAID_INSTALLMENT",
      sessionId: session.id,
    });

    // El cajero declara los $3000 que efectivamente recibió.
    await cashSessionsService.close(
      session.id,
      { declared: [{ payment_method: "CASH", declared_amount: 3000 }] },
      asUser(admin),
    );

    const rows = await cashSessionsQueries.findAll({
      businessDayId: session.business_day_id,
    });
    // Antes del fix: expected no incluía los 3000 → difference = +3000 (SURPLUS).
    expect(rows[0].summary.difference).toBe(0);
  });
});

describe("Caja — pago anticipado de cuota (GAP #2)", () => {
  it("early-pay imputa el ingreso a la caja activa de la jornada", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const credit = await createCreditFixture({
      type: "LOAN",
      total_amount: 1000,
      status: "ACTIVE",
    });
    const inst = await createInstallmentFixture({
      credit_id: credit.id,
      due_date: today(),
      original_amount: 1000,
      amount_paid: 0,
      status: "PENDING",
    });
    const session = await cashSessionsService.open(
      { opening_amount: 0 },
      asUser(admin),
    );

    const res = await installmentsService.earlyPay(
      inst.id,
      "CASH",
      null,
      admin.id,
    );

    // El pago quedó imputado a la sesión (antes: cash_session_id NULL → invisible).
    const totals = await cashSessionsQueries.computeSessionTotals(session.id);
    expect(totals.collections_payments_cash).toBe(1000);

    const payRow = await pool.query(
      `SELECT cash_session_id FROM payments
       WHERE installment_id = $1 AND status = 'APPROVED'`,
      [inst.id],
    );
    expect(payRow.rows).toHaveLength(1);
    expect(payRow.rows[0].cash_session_id).toBe(session.id);

    // Crédito de una sola cuota → queda liquidado.
    expect(res.credit_settled).toBe(true);
  });

  it("el cierre cuadra con un pago anticipado declarado", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const credit = await createCreditFixture({
      type: "LOAN",
      total_amount: 1000,
      status: "ACTIVE",
    });
    const inst = await createInstallmentFixture({
      credit_id: credit.id,
      due_date: today(),
      original_amount: 1000,
      amount_paid: 0,
      status: "PENDING",
    });
    const session = await cashSessionsService.open(
      { opening_amount: 0 },
      asUser(admin),
    );

    await installmentsService.earlyPay(inst.id, "CASH", null, admin.id);

    await cashSessionsService.close(
      session.id,
      { declared: [{ payment_method: "CASH", declared_amount: 1000 }] },
      asUser(admin),
    );

    const rows = await cashSessionsQueries.findAll({
      businessDayId: session.business_day_id,
    });
    expect(rows[0].summary.difference).toBe(0);
  });
});
