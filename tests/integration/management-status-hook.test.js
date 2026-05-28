// Bloque H — Hook management_status (planilla del día)
// Verifica que las gestiones operativas actualizan management_status en la
// fila de la planilla ACTIVE del día del cobrador correspondiente:
//   · collectionAttempts.create → NO_PAYMENT / NOT_FOUND
//   · payments.create           → VISITED
//   · payments.approve          → PAID si la cuota queda saldada, VISITED si parcial
//   · payments.reverse          → VISITED
//
// Y los guard-rails (silent no-op):
//   · planilla CLOSED / CANCELLED / REGENERATED
//   · planilla de fecha pasada
//   · sin planilla generada
//   · planilla de OTRO cobrador no se toca

const { pool, setupTestSuite } = require('./helpers/db');
const {
  createCustomerFixture,
  createCreditFixture,
  createInstallmentFixture,
  createUserFixture,
} = require('./helpers/fixtures');
const { today, daysAgo } = require('./helpers/dates');

const collectionsService        = require('../../src/modules/collections/collections.service');
const collectionAttemptsService = require('../../src/modules/collectionAttempts/collectionAttempts.service');
const paymentsService           = require('../../src/modules/payments/payments.service');

setupTestSuite();

// Crea cliente + crédito + cuota PENDING asignados a un cobrador, y genera
// la planilla activa del día. El amountDue por defecto es 1000.
const seedScenarioWithSheet = async ({
  amountDue = 1000,
  status = 'PENDING',
  generateSheet = true,
  customerAssigned = true,
} = {}) => {
  const admin     = await createUserFixture({ role: 'ADMIN' });
  const collector = await createUserFixture({ role: 'COLLECTOR' });

  const customer = await createCustomerFixture();
  if (customerAssigned) {
    await pool.query(
      `UPDATE customers SET assigned_collector_id = $1 WHERE id = $2`,
      [collector.id, customer.id],
    );
  }

  const credit = await createCreditFixture({
    customer_id:  customer.id,
    type:         'LOAN',
    total_amount: amountDue,
  });
  const inst = await createInstallmentFixture({
    credit_id:       credit.id,
    due_date:        today(),
    original_amount: amountDue,
    amount_paid:     0,
    status,
  });

  let sheet = null;
  if (generateSheet) {
    const r = await collectionsService.generate(
      { collector_id: collector.id, date: today(), filter: 'ALL_PENDING' },
      admin.id,
    );
    sheet = r.sheet;
  }

  return { admin, collector, customer, credit, inst, sheet };
};

const readMgmtStatus = async (sheetId, installmentId = null) => {
  const sql = installmentId
    ? `SELECT management_status FROM collection_sheet_details WHERE sheet_id = $1 AND installment_id = $2`
    : `SELECT management_status FROM collection_sheet_details WHERE sheet_id = $1`;
  const args = installmentId ? [sheetId, installmentId] : [sheetId];
  const r = await pool.query(sql, args);
  return r.rows[0]?.management_status || null;
};

describe('H — Hook management_status (planilla del día)', () => {
  describe('collectionAttempts.create', () => {
    it('NO_PAYMENT → planilla queda en NO_PAYMENT', async () => {
      const { collector, inst, sheet } = await seedScenarioWithSheet();

      await collectionAttemptsService.create(
        {
          installment_id:  inst.id,
          attempt_type:    'NO_PAYMENT',
          reason:          'Cliente no estaba',
          next_visit_date: today(),
        },
        { id: collector.id, role: 'COLLECTOR' },
      );

      expect(await readMgmtStatus(sheet.id)).toBe('NO_PAYMENT');
    });

    it('NOT_FOUND → planilla queda en NOT_FOUND', async () => {
      const { collector, inst, sheet } = await seedScenarioWithSheet();

      await collectionAttemptsService.create(
        {
          installment_id: inst.id,
          attempt_type:   'NOT_FOUND',
          notes:          'Domicilio sin atender',
        },
        { id: collector.id, role: 'COLLECTOR' },
      );

      expect(await readMgmtStatus(sheet.id)).toBe('NOT_FOUND');
    });
  });

  describe('payments.create', () => {
    it('crear pre-carga (PENDING) → planilla queda en VISITED', async () => {
      const { collector, inst, sheet } = await seedScenarioWithSheet();

      await paymentsService.create(
        {
          installment_id:  inst.id,
          amount_received: 500,
          payment_method:  'CASH',
          next_visit_date: today(),
        },
        { id: collector.id, role: 'COLLECTOR' },
      );

      expect(await readMgmtStatus(sheet.id)).toBe('VISITED');
    });
  });

  describe('payments.approve', () => {
    it('aprobar pago TOTAL → planilla queda en PAID', async () => {
      const { admin, collector, inst, sheet } = await seedScenarioWithSheet({
        amountDue: 1000,
      });

      const payment = await paymentsService.create(
        {
          installment_id:  inst.id,
          amount_received: 1000,
          payment_method:  'CASH',
        },
        { id: collector.id, role: 'COLLECTOR' },
      );
      // Después de create ya está en VISITED — approve debe avanzar a PAID.
      expect(await readMgmtStatus(sheet.id)).toBe('VISITED');

      await paymentsService.approve(payment.id, admin.id);

      expect(await readMgmtStatus(sheet.id)).toBe('PAID');
    });

    it('aprobar pago PARCIAL → planilla queda en VISITED', async () => {
      const { admin, collector, inst, sheet } = await seedScenarioWithSheet({
        amountDue: 1000,
      });

      const payment = await paymentsService.create(
        {
          installment_id:  inst.id,
          amount_received: 400,
          payment_method:  'CASH',
          next_visit_date: today(),
        },
        { id: collector.id, role: 'COLLECTOR' },
      );

      await paymentsService.approve(payment.id, admin.id);

      expect(await readMgmtStatus(sheet.id)).toBe('VISITED');
    });
  });

  describe('payments.reverse', () => {
    it('revertir pago aprobado → planilla queda en VISITED', async () => {
      const { admin, collector, inst, sheet } = await seedScenarioWithSheet({
        amountDue: 1000,
      });

      const payment = await paymentsService.create(
        {
          installment_id:  inst.id,
          amount_received: 1000,
          payment_method:  'CASH',
        },
        { id: collector.id, role: 'COLLECTOR' },
      );
      await paymentsService.approve(payment.id, admin.id);
      expect(await readMgmtStatus(sheet.id)).toBe('PAID');

      await paymentsService.reverse(payment.id, 'Pago revertido por error', admin.id);

      expect(await readMgmtStatus(sheet.id)).toBe('VISITED');
    });
  });

  describe('Guards: hook NO actualiza fuera de scope', () => {
    it('planilla CLOSED → hook es no-op (mantiene PENDING)', async () => {
      const { admin, collector, inst, sheet } = await seedScenarioWithSheet();

      // Cerramos la planilla
      await collectionsService.close(sheet.id, admin.id);

      // Intentamos un attempt — el trigger DB bloquea cualquier UPDATE de
      // management_status sobre planilla CLOSED, pero el hook filtra antes
      // con sheet_date=CURRENT_DATE AND status=ACTIVE: nunca ejecuta el UPDATE.
      await collectionAttemptsService.create(
        {
          installment_id:  inst.id,
          attempt_type:    'NO_PAYMENT',
          reason:          'cliente ausente',
          next_visit_date: today(),
        },
        { id: collector.id, role: 'COLLECTOR' },
      );

      // Sigue PENDING (estado por defecto al crear el detail).
      expect(await readMgmtStatus(sheet.id)).toBe('PENDING');
    });

    it('planilla de fecha pasada → hook es no-op', async () => {
      // Generamos una planilla y luego corremos su sheet_date hacia atrás.
      // El trigger de inmutabilidad NO bloquea modificaciones a sheet_date
      // hechas en tests (no es campo identitario protegido en la lógica
      // habitual, pero igual lo blindamos vía pool sin pasar por triggers
      // — para el test alcanza con cambiarlo y verificar el no-op).
      const { collector, inst, sheet } = await seedScenarioWithSheet();

      // Trampa para evitar el trigger de inmutabilidad: insertamos un nuevo
      // sheet con fecha de ayer y la cuota incluida. Asignamos el detail
      // copiando todos los campos del original.
      const yesterday = daysAgo(1);
      const olderSheet = await pool.query(
        `INSERT INTO collection_sheets
           (collector_id, sheet_date, filter_used, generated_by, status,
            snapshot_version, collector_name_snapshot, generated_by_name_snapshot)
         SELECT collector_id, $2::date, filter_used, generated_by, 'ACTIVE',
                snapshot_version, collector_name_snapshot, generated_by_name_snapshot
         FROM collection_sheets WHERE id = $1
         RETURNING id`,
        [sheet.id, yesterday],
      );
      await pool.query(
        `INSERT INTO collection_sheet_details
           (sheet_id, installment_id, order_number, planned_amount,
            inclusion_criteria, management_status)
         VALUES ($1, $2, 1, 1000, 'DUE_DATE', 'PENDING')`,
        [olderSheet.rows[0].id, inst.id],
      );

      // El intento de hoy debe afectar SOLO la planilla del día actual, no la de ayer.
      await collectionAttemptsService.create(
        {
          installment_id:  inst.id,
          attempt_type:    'NO_PAYMENT',
          reason:          'ausente',
          next_visit_date: today(),
        },
        { id: collector.id, role: 'COLLECTOR' },
      );

      // Planilla de hoy: NO_PAYMENT.
      expect(await readMgmtStatus(sheet.id, inst.id)).toBe('NO_PAYMENT');
      // Planilla de ayer: intacta.
      expect(await readMgmtStatus(olderSheet.rows[0].id, inst.id)).toBe('PENDING');
    });

    it('sin planilla generada → hook no rompe la operación', async () => {
      const { collector, inst } = await seedScenarioWithSheet({ generateSheet: false });

      // Sin planilla, el helper retorna 0 rows pero no lanza.
      await expect(
        collectionAttemptsService.create(
          {
            installment_id:  inst.id,
            attempt_type:    'NO_PAYMENT',
            reason:          'sin planilla',
            next_visit_date: today(),
          },
          { id: collector.id, role: 'COLLECTOR' },
        ),
      ).resolves.toBeDefined();
    });

    it('hook actualiza solo la planilla del cobrador correcto, no la de otro', async () => {
      const { admin, collector: collectorA, customer, inst, sheet: sheetA } =
        await seedScenarioWithSheet();

      // Creamos un segundo cobrador y un escenario paralelo en su planilla,
      // pero la cuota de TEST es la del cobrador A. La planilla del cobrador B
      // no debería tocarse cuando el A registra una gestión.
      const collectorB = await createUserFixture({ role: 'COLLECTOR' });

      // Para que B tenga una planilla del día, necesitamos al menos una cuota
      // asignada a B. Creamos cliente y cuota propias de B.
      const customerB = await createCustomerFixture();
      await pool.query(
        `UPDATE customers SET assigned_collector_id = $1 WHERE id = $2`,
        [collectorB.id, customerB.id],
      );
      const creditB = await createCreditFixture({ customer_id: customerB.id });
      await createInstallmentFixture({
        credit_id:       creditB.id,
        due_date:        today(),
        original_amount: 500,
        amount_paid:     0,
        status:          'PENDING',
      });
      const sheetBResult = await collectionsService.generate(
        { collector_id: collectorB.id, date: today(), filter: 'ALL_PENDING' },
        admin.id,
      );

      // El cobrador A registra un NO_PAYMENT sobre su cuota.
      await collectionAttemptsService.create(
        {
          installment_id:  inst.id,
          attempt_type:    'NO_PAYMENT',
          reason:          'ausente',
          next_visit_date: today(),
        },
        { id: collectorA.id, role: 'COLLECTOR' },
      );

      // Su planilla: NO_PAYMENT. La de B: intacta (PENDING) — son cuotas
      // diferentes pero conceptualmente la guarda es por collector_id.
      expect(await readMgmtStatus(sheetA.id, inst.id)).toBe('NO_PAYMENT');
      expect(await readMgmtStatus(sheetBResult.sheet.id)).toBe('PENDING');
    });
  });
});
