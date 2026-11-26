// Issue #73 — idempotencia (client_request_id) en operaciones admin:
//   · POST  /payments/admin-direct      → paymentsService.adminDirect
//   · POST  /credits/:id/renew          → paymentsService.renew
//   · PATCH /credits/:id/early-settlement → creditsService.earlySettlement
//
// Reutiliza el mecanismo de P08: payments.client_request_id + índice UNIQUE
// parcial (collector_id, client_request_id). Mismo id → un solo efecto y el
// reintento devuelve el resultado original; concurrentes → un solo efecto.

const { pool, setupTestSuite } = require('./helpers/db');
const {
  createCreditFixture,
  createInstallmentFixture,
  createUserFixture,
} = require('./helpers/fixtures');
const { today } = require('./helpers/dates');
const paymentsService = require('../../src/modules/payments/payments.service');
const creditsService = require('../../src/modules/credits/credits.service');
const cashSessionsService = require('../../src/modules/cashSessions/cashSessions.service');

setupTestSuite();

const KEY_A = '7f1c2e9a-3b4d-4c5e-8f6a-1b2c3d4e5f60';
const KEY_B = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d';

const countPayments = async (creditId) => {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payments p
     JOIN installments i ON i.id = p.installment_id WHERE i.credit_id = $1`,
    [creditId],
  );
  return r.rows[0].n;
};

const countSessionMovements = async () => {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM payments WHERE status = 'APPROVED'`);
  return r.rows[0].n;
};

const setupAdmin = async () => {
  const admin = await createUserFixture({ role: 'ADMIN' });
  await cashSessionsService.open({ opening_amount: 0 }, { id: admin.id, role: admin.role });
  return admin;
};

describe('#73 — admin-direct idempotente', () => {
  const body = (installmentId, extra = {}) => ({
    installment_id: installmentId,
    amount_received: 400,
    payment_method: 'CASH',
    notes: 'cobro directo',
    ...extra,
  });

  it('mismo client_request_id → un solo cobro; el reintento devuelve el original', async () => {
    const admin = await setupAdmin();
    const inst = await createInstallmentFixture({ original_amount: 1000 });

    const first = await paymentsService.adminDirect(body(inst.id, { client_request_id: KEY_A }), admin.id);
    const second = await paymentsService.adminDirect(body(inst.id, { client_request_id: KEY_A }), admin.id);

    expect(first.idempotent_replay).toBeUndefined();
    expect(second.idempotent_replay).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await countPayments(inst.credit_id)).toBe(1);
    const r = await pool.query(`SELECT amount_paid::float8 AS paid FROM installments WHERE id = $1`, [inst.id]);
    expect(r.rows[0].paid).toBe(400);
  });

  it('reintento después de saldar la cuota → replay (no 409 "ya fue pagada")', async () => {
    const admin = await setupAdmin();
    const inst = await createInstallmentFixture({ original_amount: 1000 });

    const first = await paymentsService.adminDirect(
      body(inst.id, { amount_received: 1000, client_request_id: KEY_A }), admin.id);
    const second = await paymentsService.adminDirect(
      body(inst.id, { amount_received: 1000, client_request_id: KEY_A }), admin.id);

    expect(second.id).toBe(first.id);
    expect(await countPayments(inst.credit_id)).toBe(1);
  });

  it('misma clave con otro monto → 409 IDEMPOTENCY_KEY_REUSED y sin segundo cobro', async () => {
    const admin = await setupAdmin();
    const inst = await createInstallmentFixture({ original_amount: 1000 });

    await paymentsService.adminDirect(body(inst.id, { client_request_id: KEY_A }), admin.id);
    await expect(
      paymentsService.adminDirect(body(inst.id, { amount_received: 300, client_request_id: KEY_A }), admin.id),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await countPayments(inst.credit_id)).toBe(1);
  });

  it('dos requests concurrentes con la misma clave → un solo cobro', async () => {
    const admin = await setupAdmin();
    const inst = await createInstallmentFixture({ original_amount: 1000 });
    const before = await countSessionMovements();

    const results = await Promise.allSettled([
      paymentsService.adminDirect(body(inst.id, { client_request_id: KEY_A }), admin.id),
      paymentsService.adminDirect(body(inst.id, { client_request_id: KEY_A }), admin.id),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(results[0].value.id).toBe(results[1].value.id);
    expect(results.filter((r) => r.value.idempotent_replay).length).toBe(1);
    expect(await countPayments(inst.credit_id)).toBe(1);
    expect(await countSessionMovements()).toBe(before + 1);
  });

  it('sin client_request_id → comportamiento anterior (dos cobros)', async () => {
    const admin = await setupAdmin();
    const inst = await createInstallmentFixture({ original_amount: 1000 });

    const a = await paymentsService.adminDirect(body(inst.id), admin.id);
    const b = await paymentsService.adminDirect(body(inst.id), admin.id);

    expect(a.id).not.toBe(b.id);
    expect(a.idempotent_replay).toBeUndefined();
    expect(await countPayments(inst.credit_id)).toBe(2);
  });
});

describe('#73 — renovación idempotente', () => {
  // Préstamo de 1 cuota: capital 1000, cuota congelada 1200 → interés 200.
  const setupLoan = async () => {
    const credit = await createCreditFixture({ type: 'LOAN', total_amount: 1000, installments_count: 1 });
    const inst = await createInstallmentFixture({ credit_id: credit.id, original_amount: 1200, due_date: today() });
    return { credit, inst };
  };
  const dueDate = async (id) =>
    (await pool.query(`SELECT to_char(due_date,'YYYY-MM-DD') AS d FROM installments WHERE id = $1`, [id])).rows[0].d;

  it('mismo client_request_id → una sola renovación (vencimiento corrido una vez)', async () => {
    const admin = await setupAdmin();
    const { credit, inst } = await setupLoan();

    const first = await paymentsService.renew(credit.id, { payment_method: 'CASH', client_request_id: KEY_A }, admin.id);
    const afterFirst = await dueDate(inst.id);
    const second = await paymentsService.renew(credit.id, { payment_method: 'CASH', client_request_id: KEY_A }, admin.id);

    expect(second.idempotent_replay).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await dueDate(inst.id)).toBe(afterFirst);
    expect(await countPayments(credit.id)).toBe(1);
  });

  it('dos renovaciones concurrentes con la misma clave → una sola', async () => {
    const admin = await setupAdmin();
    const { credit } = await setupLoan();

    const results = await Promise.allSettled([
      paymentsService.renew(credit.id, { payment_method: 'CASH', client_request_id: KEY_A }, admin.id),
      paymentsService.renew(credit.id, { payment_method: 'CASH', client_request_id: KEY_A }, admin.id),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(results[0].value.id).toBe(results[1].value.id);
    expect(await countPayments(credit.id)).toBe(1);
  });

  it('clave usada en un cobro directo y reusada para renovar → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const admin = await setupAdmin();
    const other = await createInstallmentFixture({ original_amount: 1000 });
    await paymentsService.adminDirect(
      { installment_id: other.id, amount_received: 100, payment_method: 'CASH', client_request_id: KEY_B }, admin.id);
    const { credit } = await setupLoan();

    await expect(
      paymentsService.renew(credit.id, { payment_method: 'CASH', client_request_id: KEY_B }, admin.id),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await countPayments(credit.id)).toBe(0);
  });
});

describe('#73 — cancelación anticipada idempotente', () => {
  const setupCredit = async () => {
    const credit = await createCreditFixture({ type: 'LOAN', total_amount: 1000, installments_count: 2 });
    await createInstallmentFixture({ credit_id: credit.id, installment_number: 1, original_amount: 600 });
    await createInstallmentFixture({ credit_id: credit.id, installment_number: 2, original_amount: 600 });
    return credit;
  };

  it('mismo client_request_id → una sola cancelación; el reintento devuelve el resultado original', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const credit = await setupCredit();

    const first = await creditsService.earlySettlement(
      credit.id, { payment_method: 'CASH', client_request_id: KEY_A }, admin.id);
    const second = await creditsService.earlySettlement(
      credit.id, { payment_method: 'CASH', client_request_id: KEY_A }, admin.id);

    expect(second.idempotent_replay).toBe(true);
    const { idempotent_replay, ...rest } = second;
    expect(idempotent_replay).toBe(true);
    expect(rest).toEqual(first);
    expect(await countPayments(credit.id)).toBe(2);
  });

  it('dos cancelaciones concurrentes con la misma clave → un solo juego de pagos', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const credit = await setupCredit();

    const results = await Promise.allSettled([
      creditsService.earlySettlement(credit.id, { payment_method: 'CASH', client_request_id: KEY_A }, admin.id),
      creditsService.earlySettlement(credit.id, { payment_method: 'CASH', client_request_id: KEY_A }, admin.id),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(results[0].value.payment_ids).toEqual(results[1].value.payment_ids);
    expect(await countPayments(credit.id)).toBe(2);
  });

  it('sin client_request_id → comportamiento anterior (segundo intento rechazado por pagos pendientes)', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const credit = await setupCredit();

    const first = await creditsService.earlySettlement(credit.id, { payment_method: 'CASH' }, admin.id);
    expect(first.idempotent_replay).toBeUndefined();
    await expect(
      creditsService.earlySettlement(credit.id, { payment_method: 'CASH' }, admin.id),
    ).rejects.toMatchObject({ status: 409 });
    expect(await countPayments(credit.id)).toBe(2);
  });
});
