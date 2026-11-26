// P10 — Excedente de un cobro sin cuota a la que imputarse (issue #32).
// Si entre la pre-carga y la aprobación otro cobro bajó el saldo del crédito,
// aprobar la pre-carga no debe registrar en caja un sobrante que no queda
// imputado a ninguna cuota: se rechaza con 409 y sin movimientos.

const { pool, setupTestSuite } = require('./helpers/db');
const {
  createCreditFixture,
  createInstallmentFixture,
  createPendingPaymentFixture,
  createUserFixture,
} = require('./helpers/fixtures');
const { daysFromNow } = require('./helpers/dates');
const paymentsService = require('../../src/modules/payments/payments.service');
const cashSessionsService = require('../../src/modules/cashSessions/cashSessions.service');

setupTestSuite();

const seedCredit = async (count, amount) => {
  const credit = await createCreditFixture({
    total_amount: count * amount,
    installments_count: count,
  });
  const installments = [];
  for (let n = 1; n <= count; n++) {
    installments.push(
      await createInstallmentFixture({
        credit_id: credit.id,
        installment_number: n,
        due_date: daysFromNow((n - 1) * 7),
        original_amount: amount,
      }),
    );
  }
  return { credit, installments };
};

const precarga = (installmentId, amount) =>
  createPendingPaymentFixture({ installment_id: installmentId, amount_received: amount });

const cashMovementsOf = async (paymentId) => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float8 AS total, COUNT(*)::int AS n
       FROM cash_movements WHERE payment_id = $1`,
    [paymentId],
  );
  return r.rows[0];
};

describe('P10 — excedente sin cuota a imputar (#32)', () => {
  it('pre-carga cuyo saldo bajó por otro cobro → 409 y sin movimiento de caja', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await cashSessionsService.open({ opening_amount: 0 }, { id: admin.id, role: admin.role });
    const { credit, installments } = await seedCredit(2, 10000);

    // Pre-carga por el total del crédito (válida al crearse).
    const late = await precarga(installments[0].id, 20000);
    // Otro camino paga la cuota 2 completa antes de aprobar la pre-carga.
    const other = await precarga(installments[1].id, 10000);
    await paymentsService.approve(other.id, admin.id);

    await expect(paymentsService.approve(late.id, admin.id)).rejects.toMatchObject({ status: 409 });

    expect(await cashMovementsOf(late.id)).toEqual({ total: 0, n: 0 });
    const p = await pool.query(`SELECT status FROM payments WHERE id = $1`, [late.id]);
    expect(p.rows[0].status).toBe('PENDING');
    const inst = await pool.query(
      `SELECT amount_paid::float8 FROM installments WHERE id = $1`,
      [installments[0].id],
    );
    expect(inst.rows[0].amount_paid).toBe(0);
    const c = await pool.query(`SELECT status FROM credits WHERE id = $1`, [credit.id]);
    expect(c.rows[0].status).toBe('ACTIVE');
  });

  it('no rompe: el excedente se distribuye entre cuotas válidas y caja = imputado', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await cashSessionsService.open({ opening_amount: 0 }, { id: admin.id, role: admin.role });
    const { credit, installments } = await seedCredit(3, 10000);

    const p = await precarga(installments[0].id, 25000);
    await paymentsService.approve(p.id, admin.id);

    const r = await pool.query(
      `SELECT COALESCE(SUM(amount_paid), 0)::float8 AS imputed FROM installments WHERE credit_id = $1`,
      [credit.id],
    );
    expect(r.rows[0].imputed).toBeCloseTo(25000, 2);
    expect((await cashMovementsOf(p.id)).total).toBeCloseTo(25000, 2);
  });
});
