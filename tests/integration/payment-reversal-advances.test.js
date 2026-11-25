// P06 — payments.reverse con cuotas adelantadas (issue #41).
// Verifica que revertir un cobro que se distribuyó sobre varias cuotas deshace
// EXACTAMENTE lo que imputó:
//   · la cuota cabecera solo pierde lo aplicado a ella (conserva pagos previos);
//   · las cuotas adelantadas y la cuota con excedente parcial vuelven a su estado;
//   · los vencimientos corridos por el adelanto vuelven a su fecha previa
//     (incluido original_due_date);
//   · el crédito SETTLED por el cobro vuelve a ACTIVE;
//   · la caja solo registra la salida del cobro cabecera.

const { pool, setupTestSuite } = require('./helpers/db');
const {
  createCreditFixture,
  createInstallmentFixture,
  createPendingPaymentFixture,
  createUserFixture,
} = require('./helpers/fixtures');
const { today, daysFromNow } = require('./helpers/dates');
const paymentsService = require('../../src/modules/payments/payments.service');
const cashSessionsService = require('../../src/modules/cashSessions/cashSessions.service');

setupTestSuite();

const openOperatingSession = (admin) =>
  cashSessionsService.open({ opening_amount: 0 }, { id: admin.id, role: admin.role });

/** Estado comparable de todas las cuotas de un crédito, por número. */
const snapshotInstallments = async (creditId) => {
  const r = await pool.query(
    `SELECT installment_number, amount_paid::float8, amount_due::float8, status,
            to_char(due_date, 'YYYY-MM-DD') AS due_date,
            to_char(original_due_date, 'YYYY-MM-DD') AS original_due_date
       FROM installments WHERE credit_id = $1 ORDER BY installment_number`,
    [creditId],
  );
  return r.rows;
};

/** Saldo pendiente total del crédito (amount_due − amount_paid). */
const creditBalance = async (creditId) => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount_due - amount_paid), 0)::float8 AS balance
       FROM installments WHERE credit_id = $1`,
    [creditId],
  );
  return r.rows[0].balance;
};

/** Crea un crédito semanal con N cuotas de `amount` venciendo hoy, +7, +14... */
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

/** Crea y aprueba un cobro en efectivo sobre una cuota. */
const approvedPayment = async (installmentId, amount, admin) => {
  const p = await createPendingPaymentFixture({
    installment_id: installmentId,
    amount_received: amount,
  });
  await paymentsService.approve(p.id, admin.id);
  return p;
};

describe('P06 — reversión de cobro con cuotas adelantadas', () => {
  it('restaura cabecera, adelantadas, excedente parcial y vencimientos; preserva pagos previos', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const session = await openOperatingSession(admin);
    const { credit, installments } = await seedCredit(4, 10000);
    const header = installments[0];

    // Pago parcial previo sobre la cabecera.
    const earlier = await approvedPayment(header.id, 3000, admin);
    const before = await snapshotInstallments(credit.id);
    const balanceBefore = await creditBalance(credit.id);

    // 31000 = 7000 (saldo cabecera) + 10000 + 10000 (adelantadas) + 4000 (parcial cuota 4).
    const big = await approvedPayment(header.id, 31000, admin);
    const applied = await snapshotInstallments(credit.id);
    expect(applied.map((i) => i.status)).toEqual(['PAID', 'PAID', 'PAID', 'PARTIAL']);
    expect(applied[3].amount_paid).toBeCloseTo(4000, 2);
    expect(applied[3].due_date).not.toBe(before[3].due_date); // el adelanto corrió la fecha

    await paymentsService.reverse(big.id, 'Error de carga', admin.id);

    // Cada cuota vuelve EXACTAMENTE a su estado previo (montos, estado, fechas).
    expect(await snapshotInstallments(credit.id)).toEqual(before);
    expect(await creditBalance(credit.id)).toBeCloseTo(balanceBefore, 2);

    // El pago previo sigue aprobado y sin reversión.
    const prev = await pool.query(
      `SELECT status, (SELECT COUNT(*) FROM payments r WHERE r.reversed_by_payment_id = p.id)::int AS reversals
         FROM payments p WHERE p.id = $1`,
      [earlier.id],
    );
    expect(prev.rows[0]).toEqual({ status: 'APPROVED', reversals: 0 });

    // Caja: una sola salida por el total del cobro cabecera, imputada a la caja activa.
    const rev = await pool.query(
      `SELECT r.id, r.amount_received::float8, r.cash_session_id
         FROM payments r WHERE r.reversed_by_payment_id = $1`,
      [big.id],
    );
    expect(rev.rows).toHaveLength(1);
    expect(rev.rows[0].amount_received).toBeCloseTo(31000, 2);
    expect(rev.rows[0].cash_session_id).toBe(session.id);
    const mov = await pool.query(
      `SELECT movement_type, amount::float8 FROM cash_movements WHERE payment_id = $1`,
      [rev.rows[0].id],
    );
    expect(mov.rows).toEqual([{ movement_type: 'REVERSAL', amount: 31000 }]);

    // Sub-pagos (adelantadas + parcial): reversión de auditoría sin caja ni movimiento.
    const childRevs = await pool.query(
      `SELECT r.amount_received::float8, r.cash_session_id,
              (SELECT COUNT(*) FROM cash_movements m WHERE m.payment_id = r.id)::int AS movs
         FROM payments c
         JOIN payments r ON r.reversed_by_payment_id = c.id
        WHERE c.parent_payment_id = $1
        ORDER BY r.amount_received DESC`,
      [big.id],
    );
    expect(childRevs.rows).toEqual([
      { amount_received: 10000, cash_session_id: null, movs: 0 },
      { amount_received: 10000, cash_session_id: null, movs: 0 },
      { amount_received: 4000, cash_session_id: null, movs: 0 },
    ]);
  });

  it('revertir el cobro que saldó el crédito lo reabre (SETTLED → ACTIVE) con cuotas restauradas', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await openOperatingSession(admin);
    const { credit, installments } = await seedCredit(3, 10000);
    const before = await snapshotInstallments(credit.id);

    const p = await approvedPayment(installments[0].id, 30000, admin);
    const settled = await pool.query(`SELECT status FROM credits WHERE id = $1`, [credit.id]);
    expect(settled.rows[0].status).toBe('SETTLED');

    await paymentsService.reverse(p.id, 'Error', admin.id);

    const after = await pool.query(
      `SELECT status, settled_at, settlement_type FROM credits WHERE id = $1`,
      [credit.id],
    );
    expect(after.rows[0]).toEqual({ status: 'ACTIVE', settled_at: null, settlement_type: null });
    expect(await snapshotInstallments(credit.id)).toEqual(before);
  });

  it('pago simple de una cuota: la reversión se comporta igual que antes (regresión)', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await openOperatingSession(admin);
    const { credit, installments } = await seedCredit(2, 10000);

    await approvedPayment(installments[0].id, 3000, admin);
    const before = await snapshotInstallments(credit.id);
    const p = await approvedPayment(installments[0].id, 2000, admin);

    await paymentsService.reverse(p.id, 'Error', admin.id);

    const after = await snapshotInstallments(credit.id);
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ amount_paid: 3000, status: 'PARTIAL', due_date: today() });
  });

  it('un sub-pago por distribución no se revierte por separado', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await openOperatingSession(admin);
    const { installments } = await seedCredit(2, 10000);
    const p = await approvedPayment(installments[0].id, 20000, admin);
    const child = await pool.query(`SELECT id FROM payments WHERE parent_payment_id = $1`, [p.id]);

    await expect(paymentsService.reverse(child.rows[0].id, 'x', admin.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/sub-pago por distribución/),
    });
  });
});
