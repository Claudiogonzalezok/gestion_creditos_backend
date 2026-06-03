// Bloque F — fixes de concurrencia en pagos (auditoría)
// Verifica las 3 defensas agregadas tras el audit profundo del módulo:
//
//   BUG #1: _applyPaymentToInstallments releee installment FRESH bajo lock
//           (antes usaba payment.amount_paid del JOIN, stale frente a races).
//   BUG #2: approve falla con 409 si la cuota es REFINANCED o PAID al tomar
//           el lock (defensa contra race con refinanciación / pago paralelo).
//   BUG #3: reject usa lock + SQL guard (WHERE status='PENDING') para no
//           sobrescribir un APPROVED a REJECTED si hubo race con approve.

const { pool, setupTestSuite } = require('./helpers/db');
const {
  createInstallmentFixture,
  createPendingPaymentFixture,
  createUserFixture,
  reloadInstallment,
} = require('./helpers/fixtures');
const { today, daysAgo } = require('./helpers/dates');
const paymentsService = require('../../src/modules/payments/payments.service');
const cashSessionsService = require('../../src/modules/cashSessions/cashSessions.service');

setupTestSuite();

// Helper local: lee el estado actual de un payment.
const reloadPayment = async (id) => {
  const r = await pool.query(`SELECT id, status, amount_received::float8, rejection_reason FROM payments WHERE id = $1`, [id]);
  return r.rows[0] || null;
};

// V4: approve requiere caja operativa abierta en la jornada. Helper
// que abre una caja con el admin como responsable operativo del turno.
const openOperatingSession = (admin) =>
  cashSessionsService.open({ opening_amount: 0 }, { id: admin.id, role: admin.role });

describe('F — fixes de concurrencia en pagos', () => {
  describe('BUG #2 — approve sobre cuota REFINANCED/PAID', () => {
    it('falla con 409 si la cuota fue REFINANCED entre create y approve', async () => {
      const admin = await createUserFixture({ role: 'ADMIN' });
      await openOperatingSession(admin);
      const inst  = await createInstallmentFixture({
        due_date:        today(),
        original_amount: 1000,
        amount_paid:     0,
        status:          'OVERDUE',
      });
      const payment = await createPendingPaymentFixture({
        installment_id:  inst.id,
        amount_received: 500,
      });

      // Simulamos race: la cuota pasó a REFINANCED después de crear la pre-carga
      await pool.query(`UPDATE installments SET status = 'REFINANCED' WHERE id = $1`, [inst.id]);

      await expect(paymentsService.approve(payment.id, admin.id))
        .rejects.toMatchObject({
          status:  409,
          message: expect.stringMatching(/refinancia|absorbida/i),
        });

      // Verificamos que la cuota quedó intacta (no se aplicó pago)
      const after = await reloadInstallment(inst.id);
      expect(after.amount_paid).toBe(0);
      expect(after.status).toBe('REFINANCED');

      // Y el payment quedó en estado PENDING (rollback del approve)
      const paymentAfter = await reloadPayment(payment.id);
      expect(paymentAfter.status).toBe('PENDING');
    });

    it('falla con 409 si la cuota ya está PAID (race con otra aprobación)', async () => {
      const admin = await createUserFixture({ role: 'ADMIN' });
      await openOperatingSession(admin);
      const inst  = await createInstallmentFixture({
        due_date:        today(),
        original_amount: 1000,
        amount_paid:     0,
        status:          'OVERDUE',
      });
      const payment = await createPendingPaymentFixture({
        installment_id:  inst.id,
        amount_received: 500,
      });

      // Simulamos race: otra aprobación concurrente liquidó la cuota
      await pool.query(
        `UPDATE installments SET status = 'PAID', amount_paid = amount_due WHERE id = $1`,
        [inst.id]
      );

      await expect(paymentsService.approve(payment.id, admin.id))
        .rejects.toMatchObject({
          status:  409,
          message: expect.stringMatching(/cancelada|pagada/i),
        });

      // Estado intacto
      const after = await reloadInstallment(inst.id);
      expect(after.amount_paid).toBeCloseTo(1000, 2);
      expect(after.status).toBe('PAID');

      // El payment NO quedó como APPROVED — el rollback lo restauró a PENDING
      const paymentAfter = await reloadPayment(payment.id);
      expect(paymentAfter.status).toBe('PENDING');
    });

    it('approve happy-path sigue funcionando (regression)', async () => {
      const admin = await createUserFixture({ role: 'ADMIN' });
      await openOperatingSession(admin);
      const inst  = await createInstallmentFixture({
        due_date:        today(),
        original_amount: 1000,
        amount_paid:     0,
        status:          'PENDING',
      });
      const payment = await createPendingPaymentFixture({
        installment_id:  inst.id,
        amount_received: 1000,
      });

      const result = await paymentsService.approve(payment.id, admin.id);

      expect(result.status).toBe('APPROVED');
      const after = await reloadInstallment(inst.id);
      expect(after.amount_paid).toBeCloseTo(1000, 2);
      expect(after.status).toBe('PAID');
    });
  });

  describe('BUG #1 — race en amount_paid stale del JOIN', () => {
    it('detecta amount_paid >= amount_due bajo lock fresh', async () => {
      // Setup: payment está en PENDING, pero entre lockAndGetPayment (que lee
      // installment vía JOIN sin lockear la cuota) y lockAndGetInstallment dentro
      // de _applyPaymentToInstallments, otra tx pagó la cuota. Simulamos esto
      // pre-seteando amount_paid = amount_due con status != PAID (poco realista
      // pero ejercita la defensa).
      const admin = await createUserFixture({ role: 'ADMIN' });
      await openOperatingSession(admin);
      const inst  = await createInstallmentFixture({
        due_date:        today(),
        original_amount: 1000,
        amount_paid:     0,
        status:          'OVERDUE',
      });
      const payment = await createPendingPaymentFixture({
        installment_id:  inst.id,
        amount_received: 500,
      });

      // Simulamos race: amount_paid llegó a amount_due via otra operación,
      // pero el status quedó "stale" como OVERDUE (caso poco realista pero
      // donde la defensa de amount_paid >= amount_due aplica).
      await pool.query(
        `UPDATE installments SET amount_paid = amount_due WHERE id = $1`,
        [inst.id]
      );

      await expect(paymentsService.approve(payment.id, admin.id))
        .rejects.toMatchObject({
          status:  409,
          message: expect.stringMatching(/cancelada|pagada/i),
        });
    });
  });

  describe('BUG #4 — getById filtra por collector_id para no-admins', () => {
    it('admin puede leer cualquier cobro', async () => {
      const admin     = await createUserFixture({ role: 'ADMIN' });
      const collector = await createUserFixture({ role: 'COLLECTOR' });
      const payment   = await createPendingPaymentFixture({ collector_id: collector.id });

      const result = await paymentsService.getById(payment.id, admin);
      expect(result.id).toBe(payment.id);
    });

    it('cobrador puede leer su propio cobro', async () => {
      const collector = await createUserFixture({ role: 'COLLECTOR' });
      const payment   = await createPendingPaymentFixture({ collector_id: collector.id });

      const result = await paymentsService.getById(payment.id, collector);
      expect(result.id).toBe(payment.id);
    });

    it('cobrador NO puede leer cobros de otro cobrador (404, no 403, para no filtrar existencia)', async () => {
      const collectorA = await createUserFixture({ role: 'COLLECTOR' });
      const collectorB = await createUserFixture({ role: 'COLLECTOR' });
      const payment    = await createPendingPaymentFixture({ collector_id: collectorA.id });

      await expect(paymentsService.getById(payment.id, collectorB))
        .rejects.toMatchObject({ status: 404 });
    });

    it('SELLER_COLLECTOR aplica el mismo filtro que COLLECTOR', async () => {
      const collectorA = await createUserFixture({ role: 'COLLECTOR' });
      const sellerCol  = await createUserFixture({ role: 'SELLER_COLLECTOR' });
      const payment    = await createPendingPaymentFixture({ collector_id: collectorA.id });

      await expect(paymentsService.getById(payment.id, sellerCol))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  describe('BUG #3 — reject con SQL guard contra race con approve', () => {
    it('falla con 409 si el payment ya está APPROVED (simula race con approve concurrente)', async () => {
      const admin = await createUserFixture({ role: 'ADMIN' });
      const inst  = await createInstallmentFixture();
      const payment = await createPendingPaymentFixture({
        installment_id:  inst.id,
        amount_received: 100,
      });

      // Simulamos race: otro admin aprobó el cobro antes de que el reject corra
      await pool.query(
        `UPDATE payments SET status = 'APPROVED', approved_by = $1, approved_at = NOW() WHERE id = $2`,
        [admin.id, payment.id]
      );

      await expect(paymentsService.reject(payment.id, 'motivo de prueba', admin.id))
        .rejects.toMatchObject({
          status:  409,
          message: expect.stringMatching(/PENDIENTE|cambió|estado/i),
        });

      // El payment debe seguir APPROVED — el guard SQL previno la sobrescritura
      const after = await reloadPayment(payment.id);
      expect(after.status).toBe('APPROVED');
      expect(after.rejection_reason).toBeNull();
    });

    it('reject happy-path sigue funcionando (regression)', async () => {
      const admin = await createUserFixture({ role: 'ADMIN' });
      const inst  = await createInstallmentFixture();
      const payment = await createPendingPaymentFixture({
        installment_id:  inst.id,
        amount_received: 100,
      });

      await paymentsService.reject(payment.id, 'no entregó comprobante', admin.id);

      const after = await reloadPayment(payment.id);
      expect(after.status).toBe('REJECTED');
      expect(after.rejection_reason).toBe('no entregó comprobante');
    });

    it('falla con 409 si el payment ya está REJECTED (operación repetida)', async () => {
      const admin = await createUserFixture({ role: 'ADMIN' });
      const inst  = await createInstallmentFixture();
      const payment = await createPendingPaymentFixture({
        installment_id:  inst.id,
        amount_received: 100,
      });

      // Primer reject OK
      await paymentsService.reject(payment.id, 'razón 1', admin.id);

      // Segundo reject debe fallar con 409 (ya no está en PENDING)
      await expect(paymentsService.reject(payment.id, 'razón 2', admin.id))
        .rejects.toMatchObject({
          status:  409,
          message: expect.stringMatching(/PENDIENTE|estado/i),
        });
    });
  });
});
