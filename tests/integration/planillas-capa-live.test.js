// Bloque I — Capa live separada en findById
// El snapshot es inmutable, pero findById adjunta un sub-objeto `live` por item
// SOLO cuando la planilla es operable hoy (ACTIVE + sheet_date = CURRENT_DATE).
// Verifica:
//   · live presente y correcto en planilla ACTIVE del día.
//   · has_pending_payment refleja pre-cargas vivas (no el snapshot congelado).
//   · today_attempt_id/type tras registrar NO_PAYMENT / NOT_FOUND.
//   · live = null en planilla CLOSED / REGENERATED / de fecha pasada.

const { pool, setupTestSuite } = require('./helpers/db');
const {
  createCustomerFixture,
  createCreditFixture,
  createInstallmentFixture,
  createUserFixture,
} = require('./helpers/fixtures');
const { today, daysAgo } = require('./helpers/dates');

const collectionsService        = require('../../src/modules/collections/collections.service');
const collectionsQueries        = require('../../src/modules/collections/collections.queries');
const collectionAttemptsService = require('../../src/modules/collectionAttempts/collectionAttempts.service');
const paymentsService           = require('../../src/modules/payments/payments.service');

setupTestSuite();

const seedScenarioWithSheet = async () => {
  const admin     = await createUserFixture({ role: 'ADMIN' });
  const collector = await createUserFixture({ role: 'COLLECTOR' });

  const customer = await createCustomerFixture();
  await pool.query(
    `UPDATE customers SET assigned_collector_id = $1 WHERE id = $2`,
    [collector.id, customer.id],
  );

  const credit = await createCreditFixture({ customer_id: customer.id, type: 'LOAN', total_amount: 1000 });
  const inst = await createInstallmentFixture({
    credit_id:       credit.id,
    due_date:        today(),
    original_amount: 1000,
    amount_paid:     0,
    status:          'PENDING',
  });

  const r = await collectionsService.generate(
    { collector_id: collector.id, date: today(), filter: 'ALL_PENDING' },
    admin.id,
  );

  return { admin, collector, customer, credit, inst, sheet: r.sheet };
};

const itemFor = (sheet, installmentId) =>
  sheet.items.find((it) => it.installment_id === installmentId);

describe('I — Capa live separada en findById', () => {
  describe('Planilla ACTIVE del día', () => {
    it('adjunta live a cada item con defaults cuando no hubo gestión', async () => {
      const { inst, sheet } = await seedScenarioWithSheet();

      const fresh = await collectionsQueries.findById(sheet.id);
      const item = itemFor(fresh, inst.id);

      expect(item.live).not.toBeNull();
      expect(item.live).toMatchObject({
        has_pending_payment: false,
        today_attempt_id:    null,
        today_attempt_type:  null,
      });
    });

    it('has_pending_payment refleja pre-carga viva (no el snapshot congelado)', async () => {
      const { collector, inst, sheet } = await seedScenarioWithSheet();

      // En el snapshot, has_pending_payment quedó congelado en false.
      expect(itemFor(sheet, inst.id).has_pending_payment).toBe(false);

      await paymentsService.create(
        { installment_id: inst.id, amount_received: 500, payment_method: 'CASH', next_visit_date: today() },
        { id: collector.id, role: 'COLLECTOR' },
      );

      const fresh = await collectionsQueries.findById(sheet.id);
      const item = itemFor(fresh, inst.id);

      // El snapshot sigue en false (inmutable); la capa live lo muestra vivo en true.
      expect(item.has_pending_payment).toBe(false);
      expect(item.live.has_pending_payment).toBe(true);
    });

    it('today_attempt_id/type se pueblan tras un NO_PAYMENT', async () => {
      const { collector, inst, sheet } = await seedScenarioWithSheet();

      await collectionAttemptsService.create(
        { installment_id: inst.id, attempt_type: 'NO_PAYMENT', reason: 'ausente', next_visit_date: today() },
        { id: collector.id, role: 'COLLECTOR' },
      );

      const fresh = await collectionsQueries.findById(sheet.id);
      const item = itemFor(fresh, inst.id);

      expect(item.live.today_attempt_id).toEqual(expect.any(String));
      expect(item.live.today_attempt_type).toBe('NO_PAYMENT');
    });

    it('today_attempt_type = NOT_FOUND tras un intento NOT_FOUND', async () => {
      const { collector, inst, sheet } = await seedScenarioWithSheet();

      await collectionAttemptsService.create(
        { installment_id: inst.id, attempt_type: 'NOT_FOUND', notes: 'sin atender' },
        { id: collector.id, role: 'COLLECTOR' },
      );

      const fresh = await collectionsQueries.findById(sheet.id);
      expect(itemFor(fresh, inst.id).live.today_attempt_type).toBe('NOT_FOUND');
    });

    it('un attempt anulado no aparece como today_attempt', async () => {
      const { collector, inst, sheet } = await seedScenarioWithSheet();

      const attempt = await collectionAttemptsService.create(
        { installment_id: inst.id, attempt_type: 'NOT_FOUND', notes: 'error' },
        { id: collector.id, role: 'COLLECTOR' },
      );
      await collectionAttemptsService.voidAttempt(attempt.id, { id: collector.id, role: 'COLLECTOR' });

      const fresh = await collectionsQueries.findById(sheet.id);
      const item = itemFor(fresh, inst.id);
      expect(item.live.today_attempt_id).toBeNull();
      expect(item.live.today_attempt_type).toBeNull();
    });
  });

  describe('Planilla NO operable → live = null', () => {
    it('planilla CLOSED devuelve live = null', async () => {
      const { admin, inst, sheet } = await seedScenarioWithSheet();
      await collectionsService.close(sheet.id, admin.id);

      const fresh = await collectionsQueries.findById(sheet.id);
      expect(itemFor(fresh, inst.id).live).toBeNull();
    });

    it('planilla de fecha pasada devuelve live = null', async () => {
      const { collector, admin } = await seedScenarioWithSheet();

      // Generamos un cliente/cuota y armamos a mano una planilla de ayer (ACTIVE)
      // para no chocar con el trigger de inmutabilidad sobre la de hoy.
      const customer = await createCustomerFixture();
      await pool.query(
        `UPDATE customers SET assigned_collector_id = $1 WHERE id = $2`,
        [collector.id, customer.id],
      );
      const credit = await createCreditFixture({ customer_id: customer.id });
      const inst = await createInstallmentFixture({ credit_id: credit.id, due_date: daysAgo(1) });

      const olderSheet = await pool.query(
        `INSERT INTO collection_sheets
           (collector_id, sheet_date, filter_used, generated_by, status, snapshot_version,
            collector_name_snapshot, generated_by_name_snapshot)
         VALUES ($1, $2::date, 'ALL_PENDING', $3, 'ACTIVE', 1, 'X', 'Y')
         RETURNING id`,
        [collector.id, daysAgo(1), admin.id],
      );
      await pool.query(
        `INSERT INTO collection_sheet_details
           (sheet_id, installment_id, order_number, planned_amount, inclusion_criteria, management_status)
         VALUES ($1, $2, 1, 1000, 'DUE_DATE', 'PENDING')`,
        [olderSheet.rows[0].id, inst.id],
      );

      const fresh = await collectionsQueries.findById(olderSheet.rows[0].id);
      expect(itemFor(fresh, inst.id).live).toBeNull();
    });
  });
});
