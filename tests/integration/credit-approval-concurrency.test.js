// Issue #48 (parte 2) — aprobación de crédito y cierre legacy concurrentes.
// Dos llamadas idénticas en paralelo (Promise.allSettled) → una sola tiene
// efecto, la otra recibe 409. Sin cuotas ni egresos duplicados, sin saldos
// negativos. Las defensas viven en la base, nunca en memoria del proceso.

const { pool, setupTestSuite, preserveTable } = require('./helpers/db');
const { createUserFixture, createCreditFixture } = require('./helpers/fixtures');
const { today } = require('./helpers/dates');
const cashSessionsService = require('../../src/modules/cashSessions/cashSessions.service');
const cashSessionsQueries = require('../../src/modules/cashSessions/cashSessions.queries');
const creditsService = require('../../src/modules/credits/credits.service');
const cashRegisterService = require('../../src/modules/cashRegister/cashRegister.service');

preserveTable('interest_rates');
setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });
const twice = (fn) => Promise.allSettled([fn(), fn()]);
const outcome = (results) => ({
  ok: results.filter((r) => r.status === 'fulfilled').length,
  conflicts: results.filter((r) => r.status === 'rejected' && r.reason?.status === 409).length,
});

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

describe('#48 — aprobación de crédito concurrente', () => {
  it('aprobar el mismo LOAN dos veces: una aprueba, la otra 409; cuotas y egreso una sola vez', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await ensureRate({ frequency: 'WEEKLY', installments: 2, rate: 0.1 });
    const credit = await createCreditFixture({
      type: 'LOAN', status: 'PENDING_APPROVAL', total_amount: 40000,
      installments_count: 2, payment_frequency: 'WEEKLY', approved_at: null,
    });
    const session = await cashSessionsService.open({ opening_amount: 100000 }, asUser(admin));

    const res = outcome(await twice(() => creditsService.approve(credit.id, admin.id)));

    expect(res).toEqual({ ok: 1, conflicts: 1 });
    const n = await pool.query(
      `SELECT COUNT(*)::int AS n FROM installments WHERE credit_id = $1`, [credit.id],
    );
    expect(n.rows[0].n).toBe(2);
    const totals = await cashSessionsQueries.computeSessionTotals(session.id);
    expect(totals.outflows_loans_cash).toBe(40000);
    const c = await pool.query(`SELECT status FROM credits WHERE id = $1`, [credit.id]);
    expect(c.rows[0].status).toBe('ACTIVE');
  });
});

describe('#48 — cierre legacy de cash_registers concurrente', () => {
  it('cerrar la misma fecha dos veces en paralelo: un solo cierre, el otro 409', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const date = today();
    const close = () => cashRegisterService.close(
      { register_date: date, declared_cash: 0, force: true }, admin.id,
    );

    const res = outcome(await twice(close));

    expect(res).toEqual({ ok: 1, conflicts: 1 });
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM cash_registers WHERE register_date = $1`, [date],
    );
    expect(r.rows[0].n).toBe(1);
  });
});
