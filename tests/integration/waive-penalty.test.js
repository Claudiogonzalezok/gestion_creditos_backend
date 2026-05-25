// Bloque D — installments.queries.waivePenalty + service.waivePenalty
// Verifica:
//   · La query SQL recalcula status correctamente tras condonar mora.
//   · El status post-condonación respeta overdue derivado (due_date + grace).
//   · La política defensiva del service rechaza condonar cuotas PAID.

const { pool, setupTestSuite } = require('./helpers/db');
const { createInstallmentFixture, reloadInstallment } = require('./helpers/fixtures');
const { today, daysAgo, daysFromNow } = require('./helpers/dates');
const installmentsQueries = require('../../src/modules/installments/installments.queries');
const installmentsService = require('../../src/modules/installments/installments.service');

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

  it('condona mora cuando pago cubre original → PAID', async () => {
    // Cliente pagó capital + mora (1100). Si admin condona, queda overpay
    // pero status correcto = PAID (amount_paid >= original_amount).
    const inst = await createInstallmentFixture({
      due_date:        today(),
      original_amount: 1000,
      penalty_amount:  100,
      amount_due:      1100,
      amount_paid:     1100,
      status:          'PAID',
    });

    await installmentsQueries.waivePenalty(inst.id, GRACE);

    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBe(0);
    expect(after.amount_due).toBeCloseTo(1000, 2);
    expect(after.status).toBe('PAID');
  });

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
