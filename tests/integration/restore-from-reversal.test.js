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

  // El estado "amount_paid > amount_due" (overpay) lo bloquea la DB vía
  // CHECK constraint installments_amount_paid_check. No es posible armar la
  // fixture, por lo tanto no hay caso de test para reversión sobre overpay.
});
