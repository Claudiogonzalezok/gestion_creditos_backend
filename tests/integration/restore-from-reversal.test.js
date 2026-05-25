// Bloque C — payments.queries.restoreInstallmentFromReversal
// Verifica que al revertir un cobro, el status se recalcula correctamente
// usando due_date + grace_days; si la cuota seguía vencida vuelve a OVERDUE
// en lugar de degradarse a PENDING/PARTIAL.

const { setupTestSuite, withTestClient } = require('./helpers/db');
const { createInstallmentFixture, reloadInstallment } = require('./helpers/fixtures');
const { today, daysAgo, daysFromNow } = require('./helpers/dates');
const { restoreInstallmentFromReversal } = require('../../src/modules/payments/payments.queries');

setupTestSuite();

const GRACE = 3;

describe('C — restoreInstallmentFromReversal', () => {
  it('reversión sobre cuota PAID vencida vuelve a OVERDUE', async () => {
    // Cliente había pagado el total de una cuota ya vencida. Se revierte todo.
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(10),
      original_amount: 1000,
      amount_paid:     1000,
      status:          'PAID',
    });

    await withTestClient((client) =>
      restoreInstallmentFromReversal(client, inst.id, 1000, GRACE)
    );

    const after = await reloadInstallment(inst.id);
    expect(after.amount_paid).toBe(0);
    expect(after.status).toBe('OVERDUE');
  });

  it('reversión parcial sobre PAID dentro de gracia vuelve a PARTIAL', async () => {
    const inst = await createInstallmentFixture({
      due_date:        today(),         // dentro de gracia
      original_amount: 1000,
      amount_paid:     1000,
      status:          'PAID',
    });

    await withTestClient((client) =>
      restoreInstallmentFromReversal(client, inst.id, 300, GRACE)
    );

    const after = await reloadInstallment(inst.id);
    expect(after.amount_paid).toBeCloseTo(700, 2);
    expect(after.status).toBe('PARTIAL');
  });

  it('reversión total dentro de gracia vuelve a PENDING', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysFromNow(5),
      original_amount: 1000,
      amount_paid:     1000,
      status:          'PAID',
    });

    await withTestClient((client) =>
      restoreInstallmentFromReversal(client, inst.id, 1000, GRACE)
    );

    const after = await reloadInstallment(inst.id);
    expect(after.amount_paid).toBe(0);
    expect(after.status).toBe('PENDING');
  });

  it('reversión parcial sobre cuota vencida vuelve a OVERDUE (no PARTIAL)', async () => {
    // Caso crítico: revertir un cobro sobre cuota vencida hace 10 días
    // NO debe degradar el status a PARTIAL — la vencidez no se "olvida".
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(10),
      original_amount: 1000,
      amount_paid:     1000,
      status:          'PAID',
    });

    await withTestClient((client) =>
      restoreInstallmentFromReversal(client, inst.id, 400, GRACE)
    );

    const after = await reloadInstallment(inst.id);
    expect(after.amount_paid).toBeCloseTo(600, 2);
    expect(after.status).toBe('OVERDUE');
  });

  it('reversión que dejaría amount_paid negativo se trunca a 0', async () => {
    const inst = await createInstallmentFixture({
      due_date:        today(),
      original_amount: 1000,
      amount_paid:     300,
      status:          'PARTIAL',
    });

    // Intentamos revertir 500 pero solo había 300 → GREATEST(amount_paid - 500, 0) = 0
    await withTestClient((client) =>
      restoreInstallmentFromReversal(client, inst.id, 500, GRACE)
    );

    const after = await reloadInstallment(inst.id);
    expect(after.amount_paid).toBe(0);
    expect(after.status).toBe('PENDING');
  });

  it('reversión sobre cuota dentro de gracia con saldo restante → PARTIAL', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(1),         // dentro de gracia (1 < 3)
      original_amount: 1000,
      amount_paid:     800,
      status:          'PARTIAL',
    });

    await withTestClient((client) =>
      restoreInstallmentFromReversal(client, inst.id, 300, GRACE)
    );

    const after = await reloadInstallment(inst.id);
    expect(after.amount_paid).toBeCloseTo(500, 2);
    expect(after.status).toBe('PARTIAL');
  });

  it('reversión que aún cubre amount_due deja PAID (raro pero posible con overpay)', async () => {
    // Edge: cuota con paid > amount_due (no debería ocurrir, pero defensivo).
    // Si tras revertir aún paid >= amount_due, sigue PAID.
    const inst = await createInstallmentFixture({
      due_date:        today(),
      original_amount: 1000,
      amount_paid:     1500,
      amount_due:      1000,    // override explícito para forzar paid > due
      status:          'PAID',
    });

    await withTestClient((client) =>
      restoreInstallmentFromReversal(client, inst.id, 300, GRACE)
    );

    const after = await reloadInstallment(inst.id);
    expect(after.amount_paid).toBeCloseTo(1200, 2);
    expect(after.status).toBe('PAID');     // 1200 >= 1000
  });
});
