// Bloque G — Inmutabilidad de planillas (migration 019)
// Verifica que collection_sheets + collection_sheet_details son documentos
// históricos congelados desde la generación. Cualquier cambio posterior a las
// tablas live (mora, edits de clientes, nuevos antecedentes, pagos) NO debe
// reflejarse en la planilla.
//
// También verifica:
//   · Trigger DB rechaza UPDATE de columnas snapshot.
//   · Trigger DB rechaza update de management_status fuera de ACTIVE/today.
//   · Ciclo de vida: ACTIVE → CLOSED / CANCELLED / REGENERATED.

const { pool, setupTestSuite } = require('./helpers/db');
const {
  createCustomerFixture,
  createCreditFixture,
  createInstallmentFixture,
  createUserFixture,
} = require('./helpers/fixtures');
const { today, daysAgo } = require('./helpers/dates');
const collectionsService = require('../../src/modules/collections/collections.service');

setupTestSuite();

// Helper: genera una planilla para un cobrador con cuotas vencidas/pendientes.
const seedScenario = async ({ customerOverrides = {} } = {}) => {
  const admin     = await createUserFixture({ role: 'ADMIN' });
  const collector = await createUserFixture({ role: 'COLLECTOR' });

  const customer = await createCustomerFixture({
    full_name: 'Original Name',
    phone:     '1100000000',
    address:   'Original Address 123',
    ...customerOverrides,
  });
  // El cobrador debe estar asignado al cliente para que la planilla lo incluya
  await pool.query(
    `UPDATE customers SET assigned_collector_id = $1 WHERE id = $2`,
    [collector.id, customer.id]
  );

  const credit = await createCreditFixture({ customer_id: customer.id, type: 'LOAN' });
  const inst   = await createInstallmentFixture({
    credit_id:       credit.id,
    due_date:        daysAgo(10),
    original_amount: 1000,
    amount_paid:     0,
    status:          'OVERDUE',
  });

  return { admin, collector, customer, credit, inst };
};

const generatePlanilla = async (collector, admin) => {
  const result = await collectionsService.generate(
    {
      collector_id: collector.id,
      date:         today(),
      filter:       'ALL_PENDING',
    },
    admin.id
  );
  return result.sheet;
};

describe('G — Planillas inmutables (snapshot v1)', () => {
  describe('Snapshot persiste todos los datos al generar', () => {
    it('al generar, snapshot_version=1 y collector_name_snapshot persisten', async () => {
      const { admin, collector } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);

      expect(sheet.snapshot_version).toBe(1);
      expect(sheet.collector_name).toBe('Test User'); // viene del COALESCE; snapshot ya está poblado
      expect(sheet.items.length).toBe(1);

      const item = sheet.items[0];
      expect(item.customer_name).toBe('Original Name');
      expect(item.customer_phone).toBe('1100000000');
      expect(item.amount_due).toBeCloseTo(1000, 2);
    });
  });

  describe('Inmutabilidad: cambios live NO afectan la planilla', () => {
    it('aplicar mora a la cuota NO cambia amount_due de la planilla', async () => {
      const { admin, collector, inst } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);
      const originalAmount = sheet.items[0].amount_due;

      // Simulamos que el cron aplica mora (cambia amount_due de la cuota)
      await pool.query(
        `UPDATE installments
         SET penalty_amount = 50, amount_due = original_amount + 50,
             last_penalty_applied_at = CURRENT_DATE
         WHERE id = $1`,
        [inst.id]
      );

      // Re-leemos la planilla — debe seguir mostrando los valores originales
      const fresh = await collectionsService.getById(sheet.id, admin);
      expect(fresh.items[0].amount_due).toBeCloseTo(originalAmount, 2);
      expect(fresh.items[0].penalty_amount).toBe(0);
    });

    it('cambiar teléfono del cliente NO cambia la planilla', async () => {
      const { admin, collector, customer } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);

      // Admin cambia el teléfono después de generar la planilla
      await pool.query(
        `UPDATE customers SET phone = '9999999999' WHERE id = $1`,
        [customer.id]
      );

      const fresh = await collectionsService.getById(sheet.id, admin);
      expect(fresh.items[0].customer_phone).toBe('1100000000');
    });

    it('cambiar dirección del cliente NO cambia la planilla', async () => {
      const { admin, collector, customer } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);

      await pool.query(
        `UPDATE customers SET address = 'New Address 456' WHERE id = $1`,
        [customer.id]
      );

      const fresh = await collectionsService.getById(sheet.id, admin);
      expect(fresh.items[0].customer_address).toBe('Original Address 123');
    });

    it('aprobar un pago NO cambia el installment_status de la planilla', async () => {
      const { admin, collector, inst } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);

      // Cuota pasa a PAID en la tabla live
      await pool.query(
        `UPDATE installments SET status = 'PAID', amount_paid = amount_due WHERE id = $1`,
        [inst.id]
      );

      const fresh = await collectionsService.getById(sheet.id, admin);
      expect(fresh.items[0].installment_status).toBe('OVERDUE'); // snapshot original
    });

    it('registrar un collection_attempt nuevo NO aparece en la planilla', async () => {
      const { admin, collector, inst } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);

      // Cobrador registra un intento NUEVO
      await pool.query(
        `INSERT INTO collection_attempts
           (installment_id, collector_id, created_by, attempt_type, reason, notes)
         VALUES ($1, $2, $2, 'NO_PAYMENT', 'cliente sin plata', NULL)`,
        [inst.id, collector.id]
      );

      const fresh = await collectionsService.getById(sheet.id, admin);
      // El antecedente debe seguir siendo el original (NULL en este caso)
      expect(fresh.items[0].antecedent_type).toBeNull();
    });
  });

  describe('Trigger DB: rechaza UPDATE de snapshot columns', () => {
    it('rechaza modificar amount_due_snapshot', async () => {
      const { admin, collector } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);
      const detailId = (await pool.query(
        `SELECT id FROM collection_sheet_details WHERE sheet_id = $1 LIMIT 1`,
        [sheet.id]
      )).rows[0].id;

      await expect(pool.query(
        `UPDATE collection_sheet_details SET amount_due_snapshot = 9999 WHERE id = $1`,
        [detailId]
      )).rejects.toThrow(/inmutables/i);
    });

    it('rechaza modificar customer_phone_snapshot', async () => {
      const { admin, collector } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);
      const detailId = (await pool.query(
        `SELECT id FROM collection_sheet_details WHERE sheet_id = $1 LIMIT 1`,
        [sheet.id]
      )).rows[0].id;

      await expect(pool.query(
        `UPDATE collection_sheet_details SET customer_phone_snapshot = '0000' WHERE id = $1`,
        [detailId]
      )).rejects.toThrow(/inmutables/i);
    });

    it('rechaza modificar planned_amount (snapshot legacy)', async () => {
      const { admin, collector } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);
      const detailId = (await pool.query(
        `SELECT id FROM collection_sheet_details WHERE sheet_id = $1 LIMIT 1`,
        [sheet.id]
      )).rows[0].id;

      await expect(pool.query(
        `UPDATE collection_sheet_details SET planned_amount = 9999 WHERE id = $1`,
        [detailId]
      )).rejects.toThrow(/inmutables/i);
    });
  });

  describe('Trigger DB: management_status guarda regla ACTIVE/today', () => {
    it('permite update si planilla ACTIVE y sheet_date = today', async () => {
      const { admin, collector } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);
      const detailId = (await pool.query(
        `SELECT id FROM collection_sheet_details WHERE sheet_id = $1 LIMIT 1`,
        [sheet.id]
      )).rows[0].id;

      await pool.query(
        `UPDATE collection_sheet_details SET management_status = 'VISITED' WHERE id = $1`,
        [detailId]
      );
      const after = await pool.query(
        `SELECT management_status FROM collection_sheet_details WHERE id = $1`,
        [detailId]
      );
      expect(after.rows[0].management_status).toBe('VISITED');
    });

    it('rechaza update si planilla CLOSED', async () => {
      const { admin, collector } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);
      await collectionsService.close(sheet.id, admin.id);

      const detailId = (await pool.query(
        `SELECT id FROM collection_sheet_details WHERE sheet_id = $1 LIMIT 1`,
        [sheet.id]
      )).rows[0].id;

      await expect(pool.query(
        `UPDATE collection_sheet_details SET management_status = 'VISITED' WHERE id = $1`,
        [detailId]
      )).rejects.toThrow(/management_status|editable/i);
    });

    // Nota: la regla "sheet_date != CURRENT_DATE bloquea" no se testea aquí
    // porque el propio trigger trg_collection_sheet_immutability hace
    // sheet_date inmutable post-insert. La regla queda cubierta indirectamente
    // por el test "rechaza update si planilla CLOSED" (mismo branch del guard).
  });

  describe('Ciclo de vida: close, cancel, regenerate', () => {
    it('close marca status=CLOSED, closed_at, closed_by', async () => {
      const { admin, collector } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);

      await collectionsService.close(sheet.id, admin.id);
      const r = await pool.query(
        `SELECT status, closed_at, closed_by FROM collection_sheets WHERE id = $1`,
        [sheet.id]
      );
      expect(r.rows[0].status).toBe('CLOSED');
      expect(r.rows[0].closed_at).not.toBeNull();
      expect(r.rows[0].closed_by).toBe(admin.id);
    });

    it('close sobre planilla ya CLOSED → 409', async () => {
      const { admin, collector } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);
      await collectionsService.close(sheet.id, admin.id);

      await expect(collectionsService.close(sheet.id, admin.id))
        .rejects.toMatchObject({ status: 409 });
    });

    it('cancel marca status=CANCELLED', async () => {
      const { admin, collector } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);

      await collectionsService.cancel(sheet.id);
      const r = await pool.query(
        `SELECT status FROM collection_sheets WHERE id = $1`,
        [sheet.id]
      );
      expect(r.rows[0].status).toBe('CANCELLED');
    });

    it('cancel sobre planilla CLOSED → 409 (terminal)', async () => {
      const { admin, collector } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);
      await collectionsService.close(sheet.id, admin.id);

      await expect(collectionsService.cancel(sheet.id))
        .rejects.toMatchObject({ status: 409 });
    });
  });

  describe('Trigger DB: transiciones de estado prohibidas', () => {
    it('rechaza intentar pasar CLOSED → ACTIVE (terminal)', async () => {
      const { admin, collector } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);
      await collectionsService.close(sheet.id, admin.id);

      await expect(pool.query(
        `UPDATE collection_sheets SET status = 'ACTIVE' WHERE id = $1`,
        [sheet.id]
      )).rejects.toThrow(/terminal|transición/i);
    });

    it('rechaza modificar collector_name_snapshot post-generación', async () => {
      const { admin, collector } = await seedScenario();
      const sheet = await generatePlanilla(collector, admin);

      await expect(pool.query(
        `UPDATE collection_sheets SET collector_name_snapshot = 'Otro' WHERE id = $1`,
        [sheet.id]
      )).rejects.toThrow(/inmutables/i);
    });
  });
});
