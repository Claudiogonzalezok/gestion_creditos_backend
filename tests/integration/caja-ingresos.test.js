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
const reportsQueries = require("../../src/modules/reports/reports.queries");
const reportsService = require("../../src/modules/reports/reports.service");
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
       (credit_id, amount, payment_method, approved_by, payment_type, register_date, cash_session_id, amount_cash, amount_transfer)
     VALUES ($1, $2, 'CASH', $3, $4, $5, $6, $2, 0)`,
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
      { payment_method: "CASH" },
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

    await installmentsService.earlyPay(
      inst.id,
      { payment_method: "CASH" },
      admin.id,
    );

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

describe("Dashboard — 'Recaudado hoy' cuadra con la caja", () => {
  it("netea reversiones e incluye cuotas pre-pagadas (getSummaryReport == caja)", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const credit = await createCreditFixture({
      total_amount: 10000,
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

    // Ingresos por adelantado: enganche 2000 + cuota pre-pagada histórica 3000.
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

    // Cobro 1000 y su reversión el mismo día → neto 0.
    const insertPayment = (isReversal) =>
      pool.query(
        `INSERT INTO payments
           (installment_id, collector_id, amount_received, amount_cash, amount_transfer,
            payment_method, status, is_reversal, approved_by, approved_at, cash_session_id)
         VALUES ($1, $2, 1000, 1000, 0, 'CASH', 'APPROVED', $3, $2, $4, $5)`,
        [inst.id, admin.id, isReversal, today(), session.id],
      );
    await insertPayment(false);
    await insertPayment(true);

    const summary = await reportsQueries.getSummaryReport(3, today());
    const caja = await cashSessionsQueries.computeSessionTotals(session.id);

    // Recaudado hoy = cobros neteados (0) + enganche 2000 + prepaid 3000.
    expect(summary.today_total).toBe(5000);
    expect(summary.today_collected).toBe(0); // la reversión netea al cobro
    expect(summary.today_payments_count).toBe(1); // la reversión no es un cobro

    // Y cuadra con la caja (payments neto + down_payments con prepaid).
    const cajaColeccion =
      caja.collections_payments_cash +
      caja.collections_payments_transfer +
      caja.collections_down_payments_cash +
      caja.collections_down_payments_transfer;
    expect(summary.today_total).toBe(cajaColeccion);
  });

  it("recaudación atada a la caja: total con caja abierta, 0 al cerrarla", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const credit = await createCreditFixture({ status: "ACTIVE" });
    const inst = await createInstallmentFixture({
      credit_id: credit.id,
      due_date: today(),
      original_amount: 1500,
      amount_paid: 0,
      status: "PENDING",
    });
    const session = await cashSessionsService.open(
      { opening_amount: 0 },
      asUser(admin),
    );
    await pool.query(
      `INSERT INTO payments
         (installment_id, collector_id, amount_received, amount_cash, amount_transfer,
          payment_method, status, is_reversal, approved_by, approved_at, cash_session_id)
       VALUES ($1, $2, 1500, 1500, 0, 'CASH', 'APPROVED', FALSE, $2, $3, $4)`,
      [inst.id, admin.id, today(), session.id],
    );

    // Con la caja ABIERTA, el service reporta la recaudación de la jornada.
    const abierta = await reportsService.getSummaryReport();
    expect(abierta.today_total).toBe(1500);

    // Al CERRAR la caja, la recaudación vuelve a 0 (no queda "colgada" ni se
    // resetea por día calendario: depende de que haya una caja abierta).
    await cashSessionsService.close(
      session.id,
      { declared: [{ payment_method: "CASH", declared_amount: 1500 }] },
      asUser(admin),
    );
    const cerrada = await reportsService.getSummaryReport();
    expect(cerrada.today_total).toBe(0);
  });
});
