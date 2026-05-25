// Bloque A — overdueInstallments.job.js
// Verifica que el cron de mora aplica la Fórmula B correctamente, respeta
// grace_days, cap, invariante amount_due = original + penalty, y excluye
// cuotas REFINANCED/PAID.
//
// Defaults seedeados (vía DEFAULT_VALUES):
//   penalty_grace_days = 3
//   penalty_rate_daily = 0.005   (0.5% diario)
//   penalty_max_rate   = 0.50    (50% del capital original)

const { pool, setupTestSuite } = require('./helpers/db');
const { createInstallmentFixture, reloadInstallment } = require('./helpers/fixtures');
const { daysAgo, daysFromNow } = require('./helpers/dates');
const { markOverdueAndApplyPenalty } = require('../../src/jobs/overdueInstallments.job');

setupTestSuite();

describe('A — overdueInstallments.job', () => {
  it('aplica mora cuando due_date superó grace_days', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(10),
      original_amount: 1000,
      status:          'OVERDUE',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    // delta = (1000 - 0) * 0.005 = 5
    expect(after.penalty_amount).toBeCloseTo(5, 2);
    expect(after.amount_due).toBeCloseTo(1005, 2);
    // Invariante
    expect(after.amount_due).toBeCloseTo(after.original_amount + after.penalty_amount, 2);
  });

  it('NO aplica mora antes de grace_days (cuota dentro del período de gracia)', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(2),   // 2 < grace=3 → dentro de gracia
      original_amount: 1000,
      status:          'PENDING',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBe(0);
    expect(after.amount_due).toBeCloseTo(1000, 2);
    // No fue marcada OVERDUE porque está dentro de grace
    expect(after.status).toBe('PENDING');
  });

  it('marca PENDING → OVERDUE cuando supera grace_days', async () => {
    const inst = await createInstallmentFixture({
      due_date: daysAgo(10),
      status:   'PENDING',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    expect(after.status).toBe('OVERDUE');
    // Y como ya quedó OVERDUE en el mismo run, también recibe mora
    expect(after.penalty_amount).toBeGreaterThan(0);
  });

  it('pago parcial reduce la base de cálculo de mora (Fórmula B)', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(10),
      original_amount: 1000,
      amount_paid:     400,
      status:          'OVERDUE',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    // saldo = (1000 + 0) - 400 = 600. delta = 600 * 0.005 = 3
    expect(after.penalty_amount).toBeCloseTo(3, 2);
    expect(after.amount_due).toBeCloseTo(1003, 2);
  });

  it('respeta el cap de mora (no excede original × max_rate)', async () => {
    // penalty cerca del cap: cap = 1000 * 0.5 = 500. Pongo penalty = 499.5
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(50),
      original_amount: 1000,
      penalty_amount:  499.5,
      amount_due:      1499.5,     // override explícito para reflejar el estado preexistente
      status:          'OVERDUE',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    // delta naive = 1499.5 * 0.005 = 7.4975 → llevaría a 506.99
    // pero el cap es 500, así que queda exactamente 500
    expect(after.penalty_amount).toBeCloseTo(500, 2);
    expect(after.amount_due).toBeCloseTo(1500, 2);
  });

  it('no aplica más mora cuando ya alcanzó el cap', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(60),
      original_amount: 1000,
      penalty_amount:  500,        // ya en el cap
      amount_due:      1500,
      status:          'OVERDUE',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    // Sin cambios — la condición penalty < cap es FALSE
    expect(after.penalty_amount).toBeCloseTo(500, 2);
    expect(after.amount_due).toBeCloseTo(1500, 2);
  });

  it('excluye cuotas REFINANCED (no aplica mora ni cambia status)', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(20),
      original_amount: 1000,
      status:          'REFINANCED',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    expect(after.status).toBe('REFINANCED');
    expect(after.penalty_amount).toBe(0);
    expect(after.amount_due).toBeCloseTo(1000, 2);
  });

  it('excluye cuotas PAID (saldo cero)', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(20),
      original_amount: 1000,
      amount_paid:     1000,
      status:          'PAID',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    expect(after.status).toBe('PAID');
    expect(after.penalty_amount).toBe(0);
  });

  it('Fórmula B compuesta: dos corridas acumulan mora sobre saldo total (capped)', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(15),
      original_amount: 1000,
      status:          'OVERDUE',
    });

    // Día 1
    await markOverdueAndApplyPenalty();
    const after1 = await reloadInstallment(inst.id);
    expect(after1.penalty_amount).toBeCloseTo(5, 2);     // 1000 * 0.005
    expect(after1.amount_due).toBeCloseTo(1005, 2);

    // Día 2 — base ahora es 1005 (Fórmula B compone sobre saldo total)
    await markOverdueAndApplyPenalty();
    const after2 = await reloadInstallment(inst.id);
    expect(after2.penalty_amount).toBeCloseTo(10.025, 2); // 5 + 1005*0.005
    expect(after2.amount_due).toBeCloseTo(1010.025, 2);
  });

  it('no aplica mora a cuota con due_date futuro', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysFromNow(7),
      original_amount: 1000,
      status:          'PENDING',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    expect(after.status).toBe('PENDING');
    expect(after.penalty_amount).toBe(0);
  });

  it('registra una corrida en cron_execution_log con metadata', async () => {
    await createInstallmentFixture({
      due_date: daysAgo(10),
      status:   'OVERDUE',
    });

    await markOverdueAndApplyPenalty();

    const log = await pool.query(
      `SELECT job_name, success, affected_rows, metadata
       FROM cron_execution_log
       WHERE job_name = 'overdueInstallments'
       ORDER BY id DESC LIMIT 1`
    );
    expect(log.rows[0].success).toBe(true);
    expect(log.rows[0].affected_rows).toBeGreaterThanOrEqual(1);
    expect(log.rows[0].metadata).toMatchObject({
      penalty_applied: expect.any(Number),
      marked_overdue:  expect.any(Number),
    });
  });
});
