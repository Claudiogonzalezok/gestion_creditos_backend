// Bloque N — Integración Fase 2 (movimientos ↔ caja)
// Verifica que el snapshot/totales de la caja reflejan los movimientos reales
// imputados vía cash_session_id (payments, gastos, drops).

const { pool, setupTestSuite } = require('./helpers/db');
const {
  createUserFixture,
  createCustomerFixture,
  createCreditFixture,
  createInstallmentFixture,
} = require('./helpers/fixtures');
const cashSessions       = require('../../src/modules/cashSessions/cashSessions.service');
const cashSessionsQueries = require('../../src/modules/cashSessions/cashSessions.queries');
const paymentsService    = require('../../src/modules/payments/payments.service');
const expensesService    = require('../../src/modules/expenses/expenses.service');
const { today }          = require('./helpers/dates');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

const seedCollectorWithInstallment = async () => {
  const collector = await createUserFixture({ role: 'ADMIN' });
  const customer  = await createCustomerFixture();
  await pool.query(
    `UPDATE customers SET assigned_collector_id = $1 WHERE id = $2`,
    [collector.id, customer.id],
  );
  const credit = await createCreditFixture({ customer_id: customer.id, type: 'LOAN', total_amount: 1000 });
  const inst   = await createInstallmentFixture({
    credit_id:       credit.id,
    due_date:        today(),
    original_amount: 1000,
    amount_paid:     0,
    status:          'PENDING',
  });
  return { collector, customer, credit, inst };
};

describe('N — Integración Fase 2: movimientos ↔ caja', () => {
  it('payments.create exige caja OPEN del cobrador', async () => {
    const { collector, inst } = await seedCollectorWithInstallment();
    await expect(paymentsService.create({
      installment_id:  inst.id,
      amount_received: 500,
      payment_method:  'CASH',
      next_visit_date: today(),
    }, asUser(collector))).rejects.toMatchObject({ status: 409 });
  });

  it('payment.create vincula cash_session_id a la caja OPEN del cobrador', async () => {
    const { collector, inst } = await seedCollectorWithInstallment();
    const session = await cashSessions.open({ opening_amount: 0 }, asUser(collector));

    const payment = await paymentsService.create({
      installment_id:  inst.id,
      amount_received: 500,
      payment_method:  'CASH',
      next_visit_date: today(),
    }, asUser(collector));

    const row = await pool.query(`SELECT cash_session_id FROM payments WHERE id = $1`, [payment.id]);
    expect(row.rows[0].cash_session_id).toBe(session.id);
  });

  it('snapshot/totales suman el pago APROBADO vinculado a la caja', async () => {
    const { collector, inst } = await seedCollectorWithInstallment();
    const collectorSession = await cashSessions.open({ opening_amount: 100 }, asUser(collector));
    const admin = await createUserFixture({ role: 'ADMIN' });
    await cashSessions.open({ opening_amount: 0 }, asUser(admin));

    const payment = await paymentsService.create({
      installment_id:  inst.id,
      amount_received: 1000,
      payment_method:  'CASH',
    }, asUser(collector));
    await paymentsService.approve(payment.id, admin.id);

    const totals = await cashSessionsQueries.computeSessionTotals(collectorSession.id);
    expect(totals.collections_payments_cash).toBeCloseTo(1000, 2);
    expect(totals.collections_payments_transfer).toBe(0);

    const snap = await cashSessions.snapshot(collectorSession.id);
    expect(snap.expected.cash).toBeCloseTo(1100, 2);   // opening 100 + cobro 1000
  });

  it('cierre persiste snapshot con el ingreso real del cobro', async () => {
    const { collector, inst } = await seedCollectorWithInstallment();
    const cs = await cashSessions.open({ opening_amount: 0 }, asUser(collector));
    const admin = await createUserFixture({ role: 'ADMIN' });
    await cashSessions.open({ opening_amount: 0 }, asUser(admin));

    const payment = await paymentsService.create({
      installment_id:  inst.id,
      amount_received: 1000,
      payment_method:  'CASH',
    }, asUser(collector));
    await paymentsService.approve(payment.id, admin.id);

    const closed = await cashSessions.close(cs.id, {
      declared: [
        { payment_method: 'CASH',     declared_amount: 1000 },
        { payment_method: 'TRANSFER', declared_amount: 0 },
      ],
    }, asUser(collector));

    expect(closed.closure_snapshot.collections.payments.cash).toBeCloseTo(1000, 2);
    expect(closed.closure_snapshot.expected.cash).toBeCloseTo(1000, 2);
    expect(closed.closure_total_difference).toBe(0);
  });

  it('expenses.create exige caja OPEN y vincula cash_session_id', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    // Sin caja → 409
    await expect(expensesService.create({
      amount: 500, description: 'Combustible', expense_date: today(),
      payment_method: 'CASH',
    }, asUser(admin))).rejects.toMatchObject({ status: 409 });

    // Con caja → vincula y baja el expected
    const cs = await cashSessions.open({ opening_amount: 5000 }, asUser(admin));
    const expense = await expensesService.create({
      amount: 500, description: 'Combustible', expense_date: today(),
      payment_method: 'CASH',
    }, asUser(admin));
    expect(expense.cash_session_id).toBe(cs.id);

    const snap = await cashSessions.snapshot(cs.id);
    expect(snap.outflows.expenses.cash).toBeCloseTo(500, 2);
    expect(snap.expected.cash).toBeCloseTo(4500, 2);  // 5000 − 500
  });

  it('drops ACTIVE y reverse impactan correctamente el expected', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const cs = await cashSessions.open({ opening_amount: 10000 }, asUser(admin));
    const d = await cashSessions.addDrop(cs.id, {
      amount: 3000, payment_method: 'CASH', destination: 'Tesorería',
    }, asUser(admin));

    let snap = await cashSessions.snapshot(cs.id);
    expect(snap.drops.cash).toBe(3000);
    expect(snap.expected.cash).toBe(7000);

    await cashSessions.reverseDrop(cs.id, d.id, { reason: 'error' }, asUser(admin));
    snap = await cashSessions.snapshot(cs.id);
    expect(snap.drops.cash).toBe(0);
    expect(snap.expected.cash).toBe(10000);
  });
});
