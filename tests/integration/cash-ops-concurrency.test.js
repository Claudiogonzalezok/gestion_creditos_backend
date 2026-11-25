// Issue #48 — operaciones de dinero concurrentes: dos llamadas idénticas en
// paralelo (Promise.allSettled) → una sola tiene efecto, la otra recibe 409.
// Sin duplicados y sin saldos negativos. Las defensas viven en la base
// (FOR UPDATE / advisory lock transaccional), nunca en memoria del proceso.

const { pool, setupTestSuite } = require('./helpers/db');
const {
  createInstallmentFixture,
  createPendingPaymentFixture,
  createUserFixture,
} = require('./helpers/fixtures');
const { today } = require('./helpers/dates');
const paymentsService = require('../../src/modules/payments/payments.service');
const cashSessionsService = require('../../src/modules/cashSessions/cashSessions.service');
const cashSessionsQueries = require('../../src/modules/cashSessions/cashSessions.queries');
const expensesService = require('../../src/modules/expenses/expenses.service');
const cashRegisterService = require('../../src/modules/cashRegister/cashRegister.service');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

const twice = (fn) => Promise.allSettled([fn(), fn()]);

const outcome = (results) => ({
  ok: results.filter((r) => r.status === 'fulfilled').length,
  conflicts: results.filter((r) => r.status === 'rejected' && r.reason?.status === 409).length,
});

const generalBalance = async () => {
  const r = await pool.query(
    `SELECT current_balance::float8 AS b FROM cash_accounts
      WHERE type = 'GENERAL_CASH' AND is_active = TRUE ORDER BY created_at LIMIT 1`,
  );
  return r.rows[0].b;
};

const setGeneralBalance = (amount) =>
  pool.query(`UPDATE cash_accounts SET current_balance = $1 WHERE type = 'GENERAL_CASH'`, [amount]);

describe('#48 — operaciones de caja concurrentes', () => {
  it('aprobar el mismo cobro dos veces: una aprueba, la otra 409, pago aplicado una vez', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await cashSessionsService.open({ opening_amount: 0 }, asUser(admin));
    const inst = await createInstallmentFixture({
      due_date: today(), original_amount: 1000, amount_paid: 0, status: 'PENDING',
    });
    const payment = await createPendingPaymentFixture({ installment_id: inst.id, amount_received: 400 });

    const res = outcome(await twice(() => paymentsService.approve(payment.id, admin.id)));

    expect(res).toEqual({ ok: 1, conflicts: 1 });
    const i = await pool.query(`SELECT amount_paid::float8 AS paid FROM installments WHERE id = $1`, [inst.id]);
    expect(i.rows[0].paid).toBe(400);
  });

  it('cerrar la misma caja dos veces: un solo cierre, el otro 409', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 500 }, asUser(admin));
    const close = () => cashSessionsService.close(session.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 500 }],
    }, asUser(admin));

    const res = outcome(await twice(close));

    expect(res).toEqual({ ok: 1, conflicts: 1 });
    const d = await pool.query(
      `SELECT COUNT(*)::int AS n FROM cash_session_closure_details WHERE cash_session_id = $1`,
      [session.id],
    );
    expect(d.rows[0].n).toBe(1);
  });

  it('gasto idéntico enviado dos veces en paralelo: uno se registra, el otro 409', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await cashSessionsService.open({ opening_amount: 1000 }, asUser(admin));
    const create = () => expensesService.create({
      amount: 120, description: 'doble clic', expense_date: today(), payment_method: 'CASH',
    }, asUser(admin));

    const res = outcome(await twice(create));

    expect(res).toEqual({ ok: 1, conflicts: 1 });
    const e = await pool.query(`SELECT COUNT(*)::int AS n FROM expenses WHERE created_by = $1`, [admin.id]);
    expect(e.rows[0].n).toBe(1);
  });

  it('dos gastos COMPANY que juntos superan el saldo: uno pasa, el otro 409, saldo nunca negativo', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await setGeneralBalance(500);
    const amounts = [300, 301];

    const results = await Promise.allSettled(amounts.map((amount) => expensesService.create({
      amount, description: 'proveedor', expense_date: today(),
      payment_method: 'TRANSFER', source: 'COMPANY',
    }, asUser(admin))));

    expect(outcome(results)).toEqual({ ok: 1, conflicts: 1 });
    expect(results.find((r) => r.status === 'rejected').reason.code).toBe('INSUFFICIENT_BALANCE');
    expect(await generalBalance()).toBeGreaterThanOrEqual(0);
  });

  it('dos conversiones COMPANY por el saldo completo: delta neto 0, saldo intacto y nunca negativo', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await setGeneralBalance(500);
    const convert = () => cashRegisterService.createConversion({
      amount: 500, source_method: 'CASH', criteria: 'COMPANY',
    }, admin.id);

    await twice(convert);

    expect(await generalBalance()).toBe(500);
  });

  it('no romper: totales de un día normal de caja no cambian', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 1000 }, asUser(admin));
    const inst = await createInstallmentFixture({
      due_date: today(), original_amount: 1000, amount_paid: 0, status: 'PENDING',
    });
    const payment = await createPendingPaymentFixture({ installment_id: inst.id, amount_received: 300 });
    await paymentsService.approve(payment.id, admin.id);
    await expensesService.create({
      amount: 50, description: 'insumos', expense_date: today(), payment_method: 'CASH',
    }, asUser(admin));
    await expensesService.create({
      amount: 70, description: 'flete', expense_date: today(), payment_method: 'CASH',
    }, asUser(admin));
    await cashRegisterService.createConversion({
      amount: 100, source_method: 'CASH', criteria: 'DAILY',
    }, admin.id);

    const totals = await cashSessionsQueries.computeSessionTotals(session.id);

    expect(totals).toMatchObject({
      collections_payments_cash: 300,
      outflows_expenses_cash: 120,
      conversions_cash_delta: -100,
      conversions_transfer_delta: 100,
    });
  });
});
