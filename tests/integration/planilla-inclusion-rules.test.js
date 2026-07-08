// Bloque J — Reglas de inclusión en planilla (pre-cargas pendientes + agenda)
// Verifica findInstallmentsForSheet:
//   · Regla 9: una cuota con pre-carga PENDING viva NO entra; reaparece si se
//     rechaza; un pago aprobado parcial (sin pendiente) sí entra.
//   · Regla 10: la agenda considera pagos APPROVED — un cobro parcial aprobado
//     con next_visit conserva la fecha pactada; visita futura saca la cuota del
//     recorrido hasta esa fecha; visita de hoy entra por TODAY_AND_OVERDUE pero
//     NO por "solo vencidas" (OVERDUE).

const { pool, setupTestSuite } = require("./helpers/db");
const {
  createCustomerFixture,
  createCreditFixture,
  createInstallmentFixture,
  createUserFixture,
  createPendingPaymentFixture,
} = require("./helpers/fixtures");
const { today, daysAgo, daysFromNow } = require("./helpers/dates");
const collectionsQueries = require("../../src/modules/collections/collections.queries");

setupTestSuite();

const seedAssignedInstallment = async (collector, instOverrides = {}) => {
  const customer = await createCustomerFixture();
  await pool.query(
    `UPDATE customers SET assigned_collector_id = $1 WHERE id = $2`,
    [collector.id, customer.id],
  );
  const credit = await createCreditFixture({ customer_id: customer.id });
  const inst = await createInstallmentFixture({
    credit_id: credit.id,
    ...instOverrides,
  });
  return { customer, credit, inst };
};

const includes = (rows, instId) =>
  rows.some((r) => r.installment_id === instId);

describe("J — Reglas de inclusión en planilla", () => {
  describe("Pre-cargas pendientes (regla 9)", () => {
    it("una cuota con pre-carga PENDING no se incluye", async () => {
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const { inst } = await seedAssignedInstallment(collector, {
        due_date: daysAgo(10),
        original_amount: 1000,
        amount_paid: 0,
        status: "OVERDUE",
      });
      await createPendingPaymentFixture({
        installment_id: inst.id,
        collector_id: collector.id,
        amount_received: 1000,
        status: "PENDING",
      });

      const rows = await collectionsQueries.findInstallmentsForSheet(
        collector.id,
        today(),
        "ALL_PENDING",
      );
      expect(includes(rows, inst.id)).toBe(false);
    });

    it("si la pre-carga se rechaza, la cuota reaparece", async () => {
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const { inst } = await seedAssignedInstallment(collector, {
        due_date: daysAgo(10),
        original_amount: 1000,
        amount_paid: 0,
        status: "OVERDUE",
      });
      const pay = await createPendingPaymentFixture({
        installment_id: inst.id,
        collector_id: collector.id,
        amount_received: 1000,
        status: "PENDING",
      });

      let rows = await collectionsQueries.findInstallmentsForSheet(
        collector.id,
        today(),
        "OVERDUE",
      );
      expect(includes(rows, inst.id)).toBe(false);

      await pool.query(
        `UPDATE payments SET status = 'REJECTED' WHERE id = $1`,
        [pay.id],
      );
      rows = await collectionsQueries.findInstallmentsForSheet(
        collector.id,
        today(),
        "OVERDUE",
      );
      expect(includes(rows, inst.id)).toBe(true);
    });

    it("una cuota parcial con pago aprobado y SIN pre-carga pendiente sí entra", async () => {
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const { inst } = await seedAssignedInstallment(collector, {
        due_date: daysAgo(10),
        original_amount: 1000,
        amount_paid: 400,
        status: "PARTIAL",
      });
      await createPendingPaymentFixture({
        installment_id: inst.id,
        collector_id: collector.id,
        amount_received: 400,
        status: "APPROVED",
      });

      const rows = await collectionsQueries.findInstallmentsForSheet(
        collector.id,
        today(),
        "OVERDUE",
      );
      expect(includes(rows, inst.id)).toBe(true);
    });
  });

  describe("Agenda respeta pagos aprobados (regla 10)", () => {
    it("pago parcial aprobado con visita FUTURA: no aparece antes de la fecha", async () => {
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const { inst } = await seedAssignedInstallment(collector, {
        due_date: daysAgo(10),
        original_amount: 1000,
        amount_paid: 400,
        status: "PARTIAL",
      });
      await createPendingPaymentFixture({
        installment_id: inst.id,
        collector_id: collector.id,
        amount_received: 400,
        status: "APPROVED",
        next_visit_date: daysFromNow(5),
      });

      const rows = await collectionsQueries.findInstallmentsForSheet(
        collector.id,
        today(),
        "TODAY_AND_OVERDUE",
      );
      expect(includes(rows, inst.id)).toBe(false);
    });

    it("pago parcial aprobado con visita HOY: aparece en vencidas+hoy", async () => {
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const { inst } = await seedAssignedInstallment(collector, {
        due_date: daysAgo(10),
        original_amount: 1000,
        amount_paid: 400,
        status: "PARTIAL",
      });
      await createPendingPaymentFixture({
        installment_id: inst.id,
        collector_id: collector.id,
        amount_received: 400,
        status: "APPROVED",
        next_visit_date: today(),
      });

      const rows = await collectionsQueries.findInstallmentsForSheet(
        collector.id,
        today(),
        "TODAY_AND_OVERDUE",
      );
      expect(includes(rows, inst.id)).toBe(true);
    });
  });

  describe("Visita vencida en cuota aún no vencida — estado 6 (visit_lapsed)", () => {
    it("Trabajo Diario incluye la cuota; Solo hoy no", async () => {
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const { inst } = await seedAssignedInstallment(collector, {
        due_date: daysFromNow(10), // todavía no vence
        original_amount: 1000,
        amount_paid: 0,
        status: "PENDING",
      });
      // Visita programada que YA se pasó (compromiso perdido).
      await pool.query(
        `INSERT INTO collection_attempts
           (installment_id, collector_id, created_by, attempt_type, next_visit_date, notes)
         VALUES ($1, $2, $2, 'SCHEDULED_VISIT', $3, 'visita que se paso')`,
        [inst.id, collector.id, daysAgo(2)],
      );

      const trabajoDiario = await collectionsQueries.findInstallmentsForSheet(
        collector.id,
        today(),
        "TODAY_AND_OVERDUE",
      );
      const soloHoy = await collectionsQueries.findInstallmentsForSheet(
        collector.id,
        today(),
        "TODAY",
      );

      // Antes quedaba fuera de todo filtro diario; ahora el Trabajo Diario la agarra.
      expect(includes(trabajoDiario, inst.id)).toBe(true);
      // "Solo hoy" no la incluye: ni vence hoy ni tiene visita hoy.
      expect(includes(soloHoy, inst.id)).toBe(false);
    });
  });

  describe('Visita pactada para hoy y filtro "solo vencidas" (regla 10)', () => {
    const seedWithVisitToday = async (collector) => {
      const { inst } = await seedAssignedInstallment(collector, {
        due_date: daysAgo(10),
        original_amount: 1000,
        amount_paid: 400,
        status: "PARTIAL",
      });
      await createPendingPaymentFixture({
        installment_id: inst.id,
        collector_id: collector.id,
        amount_received: 400,
        status: "APPROVED",
        next_visit_date: today(),
      });
      return inst;
    };

    it('NO aparece en "solo vencidas"', async () => {
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const inst = await seedWithVisitToday(collector);
      const rows = await collectionsQueries.findInstallmentsForSheet(
        collector.id,
        today(),
        "OVERDUE",
      );
      expect(includes(rows, inst.id)).toBe(false);
    });

    it('SÍ aparece en "vencidas + hoy"', async () => {
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const inst = await seedWithVisitToday(collector);
      const rows = await collectionsQueries.findInstallmentsForSheet(
        collector.id,
        today(),
        "TODAY_AND_OVERDUE",
      );
      expect(includes(rows, inst.id)).toBe(true);
    });
  });

  describe("Filtro del día no arrastra mora vieja — PL-05", () => {
    it("TODAY incluye cuotas que vencen hoy", async () => {
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const { inst } = await seedAssignedInstallment(collector, {
        due_date: today(),
        original_amount: 1000,
        amount_paid: 0,
        status: "PENDING",
      });

      const rows = await collectionsQueries.findInstallmentsForSheet(
        collector.id,
        today(),
        "TODAY",
      );

      expect(includes(rows, inst.id)).toBe(true);
    });

    it("TODAY no incluye cuotas vencidas sin agenda", async () => {
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const { inst } = await seedAssignedInstallment(collector, {
        due_date: daysAgo(10),
        original_amount: 1000,
        amount_paid: 0,
        status: "OVERDUE",
      });

      const rows = await collectionsQueries.findInstallmentsForSheet(
        collector.id,
        today(),
        "TODAY",
      );

      expect(includes(rows, inst.id)).toBe(false);
    });
  });
});
