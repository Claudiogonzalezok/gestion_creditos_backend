// Bloque D — installments.queries.waivePenalty + service.waivePenalty
// Verifica:
//   · La query SQL recalcula status correctamente tras condonar mora.
//   · El status post-condonación respeta overdue derivado (due_date + grace).
//   · La política defensiva del service rechaza condonar cuotas PAID.

const { pool, setupTestSuite } = require('./helpers/db');
const {
  createInstallmentFixture,
  reloadInstallment,
  seedCronLogSuccess,
} = require('./helpers/fixtures');
const { today, daysAgo, daysFromNow } = require('./helpers/dates');
const installmentsQueries = require('../../src/modules/installments/installments.queries');
const installmentsService = require('../../src/modules/installments/installments.service');
const { markOverdueAndApplyPenalty } = require('../../src/jobs/overdueInstallments.job');

setupTestSuite();

const GRACE = 3;

describe('D — waivePenalty (query SQL)', () => {
  it('condona mora sin pagos → status PENDING si dentro de gracia', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysFromNow(5),
      original_amount: 1000,
      penalty_amount:  100,
      amount_due:      1100,
      amount_paid:     0,
      status:          'OVERDUE',     // estado inconsistente intencional
    });

    await installmentsQueries.waivePenalty(inst.id, GRACE);

    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBe(0);
    expect(after.amount_due).toBeCloseTo(1000, 2);   // = original
    expect(after.status).toBe('PENDING');
  });

  it('condona mora con pago parcial → PARTIAL', async () => {
    const inst = await createInstallmentFixture({
      due_date:        today(),
      original_amount: 1000,
      penalty_amount:  100,
      amount_due:      1100,
      amount_paid:     500,
      status:          'OVERDUE',
    });

    await installmentsQueries.waivePenalty(inst.id, GRACE);

    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBe(0);
    expect(after.amount_due).toBeCloseTo(1000, 2);
    expect(after.status).toBe('PARTIAL');
  });

  it('condona mora pero cuota sigue vencida → mantiene OVERDUE (vencidez derivada)', async () => {
    // La condonación elimina la mora, pero la cuota sigue impaga y vencida
    // fuera de grace. El status debe seguir OVERDUE para no perder señal.
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(10),
      original_amount: 1000,
      penalty_amount:  100,
      amount_due:      1100,
      amount_paid:     0,
      status:          'OVERDUE',
    });

    await installmentsQueries.waivePenalty(inst.id, GRACE);

    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBe(0);
    expect(after.status).toBe('OVERDUE');
  });

  // NOTA: el escenario "cuota PAID con mora pendiente, admin condona" está
  // doblemente bloqueado: el service (waivePenalty) rechaza con 409 si status
  // es PAID, y la DB tiene CHECK (amount_paid <= amount_due) que prevendría
  // el estado resultante (paid quedaría > amount_due tras bajar a original).
  // No hay test acá porque la operación es inalcanzable.

  it('respeta grace_days en el recálculo: cuota vencida 2 días con grace=3 → PENDING', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(2),         // dentro de gracia
      original_amount: 1000,
      penalty_amount:  50,
      amount_due:      1050,
      amount_paid:     0,
      status:          'OVERDUE',
    });

    await installmentsQueries.waivePenalty(inst.id, GRACE);

    const after = await reloadInstallment(inst.id);
    expect(after.status).toBe('PENDING');     // dentro de gracia, sin pagos
  });

  it('mantiene la invariante amount_due = original tras condonación', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(5),
      original_amount: 2500,
      penalty_amount:  175,
      amount_due:      2675,
      amount_paid:     0,
      status:          'OVERDUE',
    });

    await installmentsQueries.waivePenalty(inst.id, GRACE);

    const after = await reloadInstallment(inst.id);
    expect(after.amount_due).toBeCloseTo(after.original_amount, 2);
    expect(after.amount_due).toBeCloseTo(2500, 2);
  });
});

describe('D — waivePenalty (service: política defensiva)', () => {
  it('rechaza condonar mora sobre cuota PAID (saldo a favor no soportado)', async () => {
    const inst = await createInstallmentFixture({
      due_date:        today(),
      original_amount: 1000,
      penalty_amount:  100,
      amount_due:      1100,
      amount_paid:     1100,
      status:          'PAID',
    });

    await expect(installmentsService.waivePenalty(inst.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/cancelada|saldo a favor/i),
    });

    // La cuota debe quedar intacta (no se ejecutó la query)
    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBeCloseTo(100, 2);
    expect(after.amount_due).toBeCloseTo(1100, 2);
  });

  it('rechaza si la cuota no tiene mora aplicada', async () => {
    const inst = await createInstallmentFixture({
      due_date:        today(),
      original_amount: 1000,
      penalty_amount:  0,
      status:          'PENDING',
    });

    await expect(installmentsService.waivePenalty(inst.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/no tiene mora/i),
    });
  });

  it('rechaza si la cuota no existe', async () => {
    await expect(installmentsService.waivePenalty('00000000-0000-0000-0000-000000000000'))
      .rejects.toMatchObject({ status: 404 });
  });

  it('condona correctamente una cuota OVERDUE con mora aplicada', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(5),
      original_amount: 1000,
      penalty_amount:  50,
      amount_due:      1050,
      amount_paid:     0,
      status:          'OVERDUE',
    });

    const result = await installmentsService.waivePenalty(inst.id);
    expect(result.penalty_amount).toBe(0);
    expect(result.amount_due).toBeCloseTo(1000, 2);
  });
});

describe('D — waivePenalty + cron catch-up (interacción crítica)', () => {
  it('tras condonar mora, last_penalty_applied_at queda en hoy (evita re-cobro)', async () => {
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(20),
      original_amount:         1000,
      penalty_amount:          50,
      amount_due:              1050,
      last_penalty_applied_at: daysAgo(5),       // procesada por cron hace 5 días
      status:                  'OVERDUE',
    });

    await installmentsQueries.waivePenalty(inst.id, GRACE);

    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBe(0);
    // Crítico: el marcador avanza a hoy, no se queda en hace 5 días.
    expect(after.last_penalty_applied_at).toBe(today());
  });

  it('cron post-condonación arranca catch-up desde mañana (no re-cobra días condonados)', async () => {
    await seedCronLogSuccess('overdueInstallments', daysAgo(1));
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(20),
      original_amount:         1000,
      penalty_amount:          100,
      amount_due:              1100,
      last_penalty_applied_at: daysAgo(5),
      status:                  'OVERDUE',
    });

    // Admin condona hoy
    await installmentsQueries.waivePenalty(inst.id, GRACE);
    const afterWaive = await reloadInstallment(inst.id);
    expect(afterWaive.penalty_amount).toBe(0);
    expect(afterWaive.last_penalty_applied_at).toBe(today());

    // Cron corre el mismo día tras la condonación → debe ser no-op (M=0)
    await markOverdueAndApplyPenalty();
    const afterCron = await reloadInstallment(inst.id);
    expect(afterCron.penalty_amount).toBe(0);     // sin re-cobro
    expect(afterCron.amount_due).toBeCloseTo(1000, 2);
  });

  it('applyPenalty manual marca last_penalty_applied_at = hoy (evita double-charge del cron)', async () => {
    await seedCronLogSuccess('overdueInstallments', daysAgo(1));
    const inst = await createInstallmentFixture({
      due_date:                daysAgo(10),
      original_amount:         1000,
      penalty_amount:          0,
      last_penalty_applied_at: daysAgo(1),
      status:                  'OVERDUE',
    });

    // Admin aplica $25 de mora manual hoy
    await installmentsQueries.applyPenalty(inst.id, 25);
    const afterManual = await reloadInstallment(inst.id);
    expect(afterManual.penalty_amount).toBeCloseTo(25, 2);
    expect(afterManual.last_penalty_applied_at).toBe(today());

    // Cron corre el mismo día tras el manual → no debe sumar más mora
    await markOverdueAndApplyPenalty();
    const afterCron = await reloadInstallment(inst.id);
    expect(afterCron.penalty_amount).toBeCloseTo(25, 2);  // sin double-charge
  });
});
