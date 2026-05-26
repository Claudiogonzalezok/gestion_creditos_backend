// Bloque A — overdueInstallments.job.js
// Verifica que el cron de mora aplica la Fórmula B correctamente, respeta
// grace_days, cap, invariante amount_due = original + penalty, y excluye
// cuotas REFINANCED/PAID.
//
// Defaults seedeados (vía DEFAULT_VALUES):
//   penalty_grace_days = 3
//   penalty_rate_daily = 0.005   (0.5% diario)
//   penalty_max_rate   = 0.50    (50% del capital original)
//
// Nota sobre primera corrida vs catch-up:
//   El job detecta si nunca corrió antes (cron_execution_log vacío) y, en ese
//   caso, limita M=1 para evitar "big bang" inicial. Los tests del primer
//   describe NO seedeo cron_log → simulan "primera corrida".
//   Los tests del segundo describe SÍ seedeo cron_log → simulan catch-up real.

const { pool, setupTestSuite } = require('./helpers/db');
const {
  createInstallmentFixture,
  createPendingPaymentFixture,
  createUserFixture,
  reloadInstallment,
  seedCronLogSuccess,
} = require('./helpers/fixtures');
const { today, daysAgo, daysFromNow } = require('./helpers/dates');
const { markOverdueAndApplyPenalty } = require('../../src/jobs/overdueInstallments.job');

setupTestSuite();

describe('A — overdueInstallments.job — primera corrida (M=1 por seguridad)', () => {
  it('aplica mora cuando due_date superó grace_days', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(10),
      original_amount: 1000,
      status:          'OVERDUE',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    // Primera corrida: M cap a 1. delta = (1000 - 0) * (1.005 - 1) = 5
    expect(after.penalty_amount).toBeCloseTo(5, 2);
    expect(after.amount_due).toBeCloseTo(1005, 2);
    expect(after.amount_due).toBeCloseTo(after.original_amount + after.penalty_amount, 2);
    // last_penalty_applied_at se setea a hoy
    expect(after.last_penalty_applied_at).toBe(today());
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
    expect(after.status).toBe('PENDING');
    // CRÍTICO: cuota en gracia NO debe quedar marcada como "procesada hoy",
    // sino perdería días legítimos de mora al salir de gracia.
    expect(after.last_penalty_applied_at).toBeNull();
  });

  it('marca PENDING → OVERDUE cuando supera grace_days', async () => {
    const inst = await createInstallmentFixture({
      due_date: daysAgo(10),
      status:   'PENDING',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    expect(after.status).toBe('OVERDUE');
    expect(after.penalty_amount).toBeGreaterThan(0);
    expect(after.last_penalty_applied_at).toBe(today());
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
    // saldo = (1000 + 0) - 400 = 600. delta = 600 * 0.005 = 3 (M=1)
    expect(after.penalty_amount).toBeCloseTo(3, 2);
    expect(after.amount_due).toBeCloseTo(1003, 2);
  });

  it('respeta el cap de mora (no excede original × max_rate)', async () => {
    // cap = 1000 * 0.5 = 500. Pongo penalty = 499.5
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(50),
      original_amount: 1000,
      penalty_amount:  499.5,
      amount_due:      1499.5,
      status:          'OVERDUE',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    // delta naive (M=1) = 1499.5 * 0.005 = 7.4975 → 506.99; cap=500
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
    // Filtrada por la condición penalty < cap. No update, last sigue NULL.
    expect(after.penalty_amount).toBeCloseTo(500, 2);
    expect(after.amount_due).toBeCloseTo(1500, 2);
    expect(after.last_penalty_applied_at).toBeNull();
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
    expect(after.last_penalty_applied_at).toBeNull();
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
    expect(after.last_penalty_applied_at).toBeNull();
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
    expect(after.last_penalty_applied_at).toBeNull();
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
      effective_today:    expect.any(String),
      is_first_run:       true,
      cuotas_updated:     expect.any(Number),
      total_days_applied: expect.any(Number),
    });
  });
});

describe('A — overdueInstallments.job — catch-up de N días', () => {
  it('catch-up de 1 día tras corrida exitosa de ayer (caso normal post-bootstrap)', async () => {
    // No es primera corrida: seedeamos un log exitoso de ayer.
    await seedCronLogSuccess('overdueInstallments', daysAgo(1));
    // Cuota OVERDUE con last_penalty_applied_at = ayer (procesada por la corrida de ayer).
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(20),
      original_amount:         1000,
      penalty_amount:          50,
      amount_due:              1050,
      last_penalty_applied_at: daysAgo(1),
      status:                  'OVERDUE',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    // M=1. delta = (1050 - 0) * 0.005 = 5.25. new_penalty = 55.25
    expect(after.penalty_amount).toBeCloseTo(55.25, 2);
    expect(after.amount_due).toBeCloseTo(1055.25, 2);
    expect(after.last_penalty_applied_at).toBe(today());
  });

  it('catch-up de 5 días sobre cuota OVERDUE con last hace 5 días (compuesto)', async () => {
    await seedCronLogSuccess('overdueInstallments', daysAgo(5));
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(30),
      original_amount:         1000,
      penalty_amount:          0,
      amount_due:              1000,
      last_penalty_applied_at: daysAgo(5),
      status:                  'OVERDUE',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    // M=5. delta = 1000 × (1.005^5 - 1) ≈ 25.2506...
    const expectedDelta = 1000 * (Math.pow(1.005, 5) - 1);
    expect(after.penalty_amount).toBeCloseTo(expectedDelta, 2);
    expect(after.amount_due).toBeCloseTo(1000 + expectedDelta, 2);
    expect(after.last_penalty_applied_at).toBe(today());
  });

  it('cuota recién vencida durante la ventana (last=NULL, due+grace en el medio)', async () => {
    // Cron caído hace 5 días. Cuota vence hace 4 días con grace=3 → mora_start = hace 0 días.
    // M = today - mora_start + 1 = 1.
    await seedCronLogSuccess('overdueInstallments', daysAgo(5));
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(4),
      original_amount:         1000,
      last_penalty_applied_at: null,         // nunca tuvo mora
      status:                  'PENDING',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    // M=1, delta = 1000 * 0.005 = 5
    expect(after.penalty_amount).toBeCloseTo(5, 2);
    expect(after.status).toBe('OVERDUE');
    expect(after.last_penalty_applied_at).toBe(today());
  });

  it('cap alcanzado en medio del catch-up (resultado final clampeado)', async () => {
    await seedCronLogSuccess('overdueInstallments', daysAgo(200));
    // 200 días de catch-up sobre cuota vieja sin pagos → la fórmula closed-form
    // daría penalty enorme, pero LEAST clampa al cap (500).
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(300),
      original_amount:         1000,
      penalty_amount:          0,
      last_penalty_applied_at: daysAgo(200),
      status:                  'OVERDUE',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBeCloseTo(500, 2);
    expect(after.amount_due).toBeCloseTo(1500, 2);
    expect(after.last_penalty_applied_at).toBe(today());
  });

  it('idempotencia: dos corridas el mismo día → la segunda es no-op (M=0)', async () => {
    await seedCronLogSuccess('overdueInstallments', daysAgo(1));
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(20),
      original_amount:         1000,
      penalty_amount:          0,
      last_penalty_applied_at: daysAgo(1),
      status:                  'OVERDUE',
    });

    // Primera corrida del día: aplica 1 día.
    await markOverdueAndApplyPenalty();
    const after1 = await reloadInstallment(inst.id);
    expect(after1.penalty_amount).toBeCloseTo(5, 2);
    expect(after1.last_penalty_applied_at).toBe(today());

    // Segunda corrida del mismo día: M=0, no debe acumular más mora.
    await markOverdueAndApplyPenalty();
    const after2 = await reloadInstallment(inst.id);
    expect(after2.penalty_amount).toBeCloseTo(5, 2);     // sin cambio
    expect(after2.amount_due).toBeCloseTo(1005, 2);      // sin cambio
    expect(after2.last_penalty_applied_at).toBe(today());
  });

  it('REFINANCED no se toca aunque last_penalty_applied_at sea antiguo', async () => {
    await seedCronLogSuccess('overdueInstallments', daysAgo(5));
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(30),
      original_amount:         1000,
      penalty_amount:          0,
      last_penalty_applied_at: daysAgo(10),
      status:                  'REFINANCED',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    expect(after.status).toBe('REFINANCED');
    expect(after.penalty_amount).toBe(0);
    expect(after.last_penalty_applied_at).toBe(daysAgo(10)); // sin cambio
  });

  it('cuota dentro de gracia NO actualiza last_penalty_applied_at (CRÍTICO)', async () => {
    // Bug que esto previene: si se marcara last=today para una cuota aún en
    // gracia, perdería días legítimos de mora al exit de gracia (al día
    // siguiente calcularía M=1 cuando debería ser M correspondiente al día
    // posterior al fin de gracia).
    await seedCronLogSuccess('overdueInstallments', daysAgo(1));
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(2),    // dentro de gracia (2 < 3)
      original_amount:         1000,
      last_penalty_applied_at: null,
      status:                  'PENDING',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBe(0);
    expect(after.status).toBe('PENDING');
    expect(after.last_penalty_applied_at).toBeNull();  // ← clave del test
  });

  it('cuota con saldo cero durante la ventana (cliente pagó) NO acumula mora', async () => {
    // Cliente pagó durante el downtime del cron. El catch-up ve saldo=0 hoy
    // y la cuota queda PAID/sin saldo → filtrada por la condición.
    await seedCronLogSuccess('overdueInstallments', daysAgo(5));
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(20),
      original_amount:         1000,
      amount_paid:             1000,         // pagado durante la ventana
      last_penalty_applied_at: daysAgo(5),
      status:                  'PAID',
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBe(0);
    expect(after.status).toBe('PAID');
    expect(after.last_penalty_applied_at).toBe(daysAgo(5)); // sin cambio
  });

  it('mezcla de cuotas en una sola corrida con M distintos por cuota', async () => {
    await seedCronLogSuccess('overdueInstallments', daysAgo(5));
    // Cuota A: catch-up de 5 días
    const a = await createInstallmentFixture({
      due_date:                daysAgo(20),
      original_amount:         1000,
      last_penalty_applied_at: daysAgo(5),
      status:                  'OVERDUE',
    });
    // Cuota B: en gracia, M=0
    const b = await createInstallmentFixture({
      due_date:                daysAgo(2),
      original_amount:         1000,
      last_penalty_applied_at: null,
      status:                  'PENDING',
    });
    // Cuota C: vence hace 4 días (recién pasó grace), last=NULL → M=1
    const c = await createInstallmentFixture({
      due_date:                daysAgo(4),
      original_amount:         1000,
      last_penalty_applied_at: null,
      status:                  'PENDING',
    });

    await markOverdueAndApplyPenalty();

    const afterA = await reloadInstallment(a.id);
    const afterB = await reloadInstallment(b.id);
    const afterC = await reloadInstallment(c.id);

    expect(afterA.penalty_amount).toBeCloseTo(1000 * (Math.pow(1.005, 5) - 1), 2);
    expect(afterB.penalty_amount).toBe(0);
    expect(afterB.last_penalty_applied_at).toBeNull();
    expect(afterC.penalty_amount).toBeCloseTo(5, 2);
  });

  it('metadata refleja is_first_run=false cuando hay corrida previa', async () => {
    await seedCronLogSuccess('overdueInstallments', daysAgo(1));
    await createInstallmentFixture({
      due_date:                daysAgo(20),
      last_penalty_applied_at: daysAgo(1),
      status:                  'OVERDUE',
    });

    await markOverdueAndApplyPenalty();

    const log = await pool.query(
      `SELECT metadata FROM cron_execution_log
       WHERE job_name = 'overdueInstallments' AND finished_at IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    );
    expect(log.rows[0].metadata).toMatchObject({
      is_first_run:       false,
      cuotas_updated:     expect.any(Number),
      total_days_applied: expect.any(Number),
    });
  });
});

describe('A — overdueInstallments.job — respeto a pre-cargas PENDING', () => {
  it('pre-carga PENDING que cubre el saldo total → NO aplica mora', async () => {
    await seedCronLogSuccess('overdueInstallments', daysAgo(1));
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(10),
      original_amount:         1000,
      amount_paid:             0,
      last_penalty_applied_at: daysAgo(1),
      status:                  'OVERDUE',
    });
    const collector = await createUserFixture({ role: 'COLLECTOR' });
    // Pre-carga PENDING por el total del saldo
    await createPendingPaymentFixture({
      installment_id:  inst.id,
      collector_id:    collector.id,
      amount_received: 1000,
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBe(0);
    expect(after.amount_due).toBeCloseTo(1000, 2);
    // last_penalty_applied_at NO avanza — si la pre-carga se rechazara mañana,
    // el cron del día siguiente podrá aplicar la mora correspondiente.
    expect(after.last_penalty_applied_at).toBe(daysAgo(1));
  });

  it('pre-carga PENDING parcial → aplica mora solo sobre saldo no comprometido', async () => {
    await seedCronLogSuccess('overdueInstallments', daysAgo(1));
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(10),
      original_amount:         1000,
      amount_paid:             0,
      last_penalty_applied_at: daysAgo(1),
      status:                  'OVERDUE',
    });
    const collector = await createUserFixture({ role: 'COLLECTOR' });
    // Pre-carga PENDING por $400 (de un saldo de $1000). Restante a cobrar: $600.
    await createPendingPaymentFixture({
      installment_id:  inst.id,
      collector_id:    collector.id,
      amount_received: 400,
    });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    // delta = 600 * 0.005 = 3 (M=1)
    expect(after.penalty_amount).toBeCloseTo(3, 2);
    expect(after.amount_due).toBeCloseTo(1003, 2);
    expect(after.last_penalty_applied_at).toBe(today());
  });

  it('pre-carga con is_reversal=TRUE NO cuenta como compromiso', async () => {
    await seedCronLogSuccess('overdueInstallments', daysAgo(1));
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(10),
      original_amount:         1000,
      amount_paid:             0,
      last_penalty_applied_at: daysAgo(1),
      status:                  'OVERDUE',
    });
    const collector = await createUserFixture({ role: 'COLLECTOR' });
    // Pre-carga pero marcada is_reversal — no debería bloquear mora
    const payment = await createPendingPaymentFixture({
      installment_id:  inst.id,
      collector_id:    collector.id,
      amount_received: 1000,
    });
    await pool.query(
      `UPDATE payments SET is_reversal = TRUE WHERE id = $1`,
      [payment.id]
    );

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    // Mora normal sobre saldo completo
    expect(after.penalty_amount).toBeCloseTo(5, 2);
  });

  it('pre-carga REJECTED NO bloquea mora — se aplica normalmente', async () => {
    await seedCronLogSuccess('overdueInstallments', daysAgo(1));
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(10),
      original_amount:         1000,
      amount_paid:             0,
      last_penalty_applied_at: daysAgo(1),
      status:                  'OVERDUE',
    });
    const collector = await createUserFixture({ role: 'COLLECTOR' });
    const payment = await createPendingPaymentFixture({
      installment_id:  inst.id,
      collector_id:    collector.id,
      amount_received: 1000,
    });
    // Admin rechazó la pre-carga
    await pool.query(
      `UPDATE payments SET status = 'REJECTED', rejection_reason = 'test' WHERE id = $1`,
      [payment.id]
    );

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBeCloseTo(5, 2);
  });

  it('múltiples pre-cargas PENDING se suman — si combinadas cubren saldo, no mora', async () => {
    await seedCronLogSuccess('overdueInstallments', daysAgo(1));
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(10),
      original_amount:         1000,
      amount_paid:             0,
      last_penalty_applied_at: daysAgo(1),
      status:                  'OVERDUE',
    });
    const collector = await createUserFixture({ role: 'COLLECTOR' });
    // Tres pre-cargas: 300 + 400 + 300 = 1000 (cubre el total)
    await createPendingPaymentFixture({ installment_id: inst.id, collector_id: collector.id, amount_received: 300 });
    await createPendingPaymentFixture({ installment_id: inst.id, collector_id: collector.id, amount_received: 400 });
    await createPendingPaymentFixture({ installment_id: inst.id, collector_id: collector.id, amount_received: 300 });

    await markOverdueAndApplyPenalty();

    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBe(0);
    expect(after.last_penalty_applied_at).toBe(daysAgo(1));
  });
});
