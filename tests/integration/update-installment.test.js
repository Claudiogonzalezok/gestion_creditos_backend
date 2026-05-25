// Bloque B — payments.queries.updateInstallment
// Verifica que el CASE de status NO oscila OVERDUE → PARTIAL y respeta
// due_date + grace_days al recalcular el estado tras un pago.

const { setupTestSuite, withTestClient } = require('./helpers/db');
const { createInstallmentFixture, reloadInstallment } = require('./helpers/fixtures');
const { today, daysAgo, daysFromNow } = require('./helpers/dates');
const { updateInstallment } = require('../../src/modules/payments/payments.queries');

setupTestSuite();

const GRACE = 3;

describe('B — updateInstallment', () => {
  it('PENDING + pago parcial → PARTIAL', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysFromNow(7),   // futuro, sin gracia que evaluar
      original_amount: 1000,
      amount_paid:     0,
      status:          'PENDING',
    });

    const newStatus = await withTestClient((client) =>
      updateInstallment(client, inst.id, 300, inst.amount_due, inst.amount_paid, GRACE)
    );

    expect(newStatus).toBe('PARTIAL');
    const after = await reloadInstallment(inst.id);
    expect(after.amount_paid).toBeCloseTo(300, 2);
    expect(after.status).toBe('PARTIAL');
  });

  it('PARTIAL + pago que cancela → PAID', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysFromNow(7),
      original_amount: 1000,
      amount_paid:     300,
      status:          'PARTIAL',
    });

    const newStatus = await withTestClient((client) =>
      updateInstallment(client, inst.id, 700, inst.amount_due, inst.amount_paid, GRACE)
    );

    expect(newStatus).toBe('PAID');
    const after = await reloadInstallment(inst.id);
    expect(after.amount_paid).toBeCloseTo(1000, 2);
    expect(after.status).toBe('PAID');
  });

  it('OVERDUE + pago parcial → sigue OVERDUE (anti-oscilación)', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(10),      // vencida hace 10 días, fuera de gracia
      original_amount: 1000,
      amount_paid:     0,
      status:          'OVERDUE',
    });

    const newStatus = await withTestClient((client) =>
      updateInstallment(client, inst.id, 200, inst.amount_due, inst.amount_paid, GRACE)
    );

    expect(newStatus).toBe('OVERDUE');
    const after = await reloadInstallment(inst.id);
    expect(after.amount_paid).toBeCloseTo(200, 2);
    expect(after.status).toBe('OVERDUE');
  });

  it('OVERDUE + pago total → PAID (transición correcta hacia liquidación)', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(10),
      original_amount: 1000,
      amount_paid:     0,
      status:          'OVERDUE',
    });

    const newStatus = await withTestClient((client) =>
      updateInstallment(client, inst.id, 1000, inst.amount_due, inst.amount_paid, GRACE)
    );

    expect(newStatus).toBe('PAID');
    const after = await reloadInstallment(inst.id);
    expect(after.status).toBe('PAID');
  });

  it('pago tardío sobre PENDING (cron no corrió) entra directo a OVERDUE', async () => {
    // Cuota PENDING pero ya vencida pasado el grace: si el cron no corrió,
    // el status persistido no refleja la realidad. updateInstallment debe
    // derivar OVERDUE del due_date directamente, no del status anterior.
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(10),
      original_amount: 1000,
      amount_paid:     0,
      status:          'PENDING',        // estado obsoleto a propósito
    });

    const newStatus = await withTestClient((client) =>
      updateInstallment(client, inst.id, 200, inst.amount_due, inst.amount_paid, GRACE)
    );

    expect(newStatus).toBe('OVERDUE');
    const after = await reloadInstallment(inst.id);
    expect(after.status).toBe('OVERDUE');
  });

  it('pago dentro de gracia mantiene PARTIAL (no fuerza OVERDUE)', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(1),       // venció ayer, todavía en gracia (3)
      original_amount: 1000,
      amount_paid:     0,
      status:          'PENDING',
    });

    const newStatus = await withTestClient((client) =>
      updateInstallment(client, inst.id, 300, inst.amount_due, inst.amount_paid, GRACE)
    );

    expect(newStatus).toBe('PARTIAL');
  });

  it('pago = 0 mantiene status PENDING si no había saldo previo', async () => {
    // Edge case: edge case que no debería ocurrir, pero defensivo.
    const inst = await createInstallmentFixture({
      due_date:        today(),
      original_amount: 1000,
      amount_paid:     0,
      status:          'PENDING',
    });

    const newStatus = await withTestClient((client) =>
      updateInstallment(client, inst.id, 0, inst.amount_due, inst.amount_paid, GRACE)
    );

    expect(newStatus).toBe('PENDING');
  });

  it('pago > saldo restante se trunca al saldo (no over-paga)', async () => {
    const inst = await createInstallmentFixture({
      due_date:        today(),
      original_amount: 1000,
      amount_paid:     800,
      status:          'PARTIAL',
    });

    // Intentamos pagar 500 pero solo quedan 200 — el helper trunca a 200.
    const newStatus = await withTestClient((client) =>
      updateInstallment(client, inst.id, 500, inst.amount_due, inst.amount_paid, GRACE)
    );

    expect(newStatus).toBe('PAID');
    const after = await reloadInstallment(inst.id);
    expect(after.amount_paid).toBeCloseTo(1000, 2); // no excede amount_due
  });
});
