// Integración — hooks de negocio que disparan notificaciones (Sistema de
// Notificaciones, Fase 4).
//
// Cubre:
//   · Cada hook (NEW_CUSTOMER, APPROVAL_REQUEST en pago, MORA) inserta una fila
//     en `notifications` con el `type` correcto para los admins activos.
//   · CRÍTICO (spec "Falla SMTP no rompe el negocio"): si notify()/el envío de
//     notificación lanza, la operación de negocio que lo originó NO debe
//     fallar ni revertirse — el resultado de negocio ya está persistido.

const { pool, setupTestSuite } = require("./helpers/db");
const {
  createUserFixture,
  createCustomerFixture,
  createInstallmentFixture,
} = require("./helpers/fixtures");
const { today } = require("./helpers/dates");

setupTestSuite();

describe("Hooks de notificaciones — NEW_CUSTOMER", () => {
  it("crea una fila en notifications de tipo NEW_CUSTOMER para cada admin activo al registrar un cliente", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const customersService = require("../../src/modules/customers/customers.service");

    const customer = await customersService.create({
      full_name: "Cliente De Prueba",
      dni: "30123456",
      address: "Calle Falsa 123",
      phone: "1122334455",
      email: null,
    });

    const rows = await pool.query(
      `SELECT type, entity_type, entity_id, user_id FROM notifications WHERE type = 'NEW_CUSTOMER'`,
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    const forAdmin = rows.rows.find((r) => r.user_id === admin.id);
    expect(forAdmin).toBeDefined();
    expect(forAdmin.entity_id).toBe(customer.id);
  });

  it("el alta del cliente NO falla aunque notify() lance un error (best-effort)", async () => {
    await createUserFixture({ role: "ADMIN" });
    jest.resetModules();

    // Forzamos que notify() falle simulando un error interno del servicio de
    // notificaciones (ej. fallo de conexión SMTP en el hilo del email).
    jest.doMock(
      "../../src/modules/notifications/notifications.service",
      () => ({
        notify: jest
          .fn()
          .mockRejectedValue(new Error("Fallo simulado de notify()")),
      }),
    );

    const customersService = require("../../src/modules/customers/customers.service");

    const customer = await customersService.create({
      full_name: "Cliente Resiliente",
      dni: "30654321",
      address: "Calle Falsa 456",
      phone: "1122334455",
      email: null,
    });

    expect(customer.id).toBeDefined();
    expect(customer.full_name).toBe("Cliente Resiliente");

    const reloaded = await pool.query(
      `SELECT id FROM customers WHERE id = $1`,
      [customer.id],
    );
    expect(reloaded.rows.length).toBe(1);

    jest.dontMock("../../src/modules/notifications/notifications.service");
    jest.resetModules();
  });
});

describe("Hooks de notificaciones — APPROVAL_REQUEST (pago)", () => {
  it("crea una fila en notifications de tipo APPROVAL_REQUEST al registrar una pre-carga de cobro", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const collector = await createUserFixture({ role: "COLLECTOR" });
    const installment = await createInstallmentFixture({
      original_amount: 1000,
    });

    const paymentsService = require("../../src/modules/payments/payments.service");

    const payment = await paymentsService.create(
      {
        installment_id: installment.id,
        amount_received: 1000,
        payment_method: "CASH",
      },
      { id: collector.id, role: "COLLECTOR" },
    );

    expect(payment.status).toBe("PENDING");

    const rows = await pool.query(
      `SELECT type, entity_type, entity_id, user_id FROM notifications WHERE type = 'APPROVAL_REQUEST'`,
    );
    const forAdmin = rows.rows.find((r) => r.user_id === admin.id);
    expect(forAdmin).toBeDefined();
    expect(forAdmin.entity_id).toBe(payment.id);
  });

  it("la pre-carga del cobro NO falla aunque notify() lance un error (best-effort)", async () => {
    await createUserFixture({ role: "ADMIN" });
    const collector = await createUserFixture({ role: "COLLECTOR" });
    const installment = await createInstallmentFixture({
      original_amount: 1000,
    });

    jest.resetModules();
    jest.doMock(
      "../../src/modules/notifications/notifications.service",
      () => ({
        notify: jest
          .fn()
          .mockRejectedValue(new Error("Fallo simulado de notify()")),
      }),
    );

    const paymentsService = require("../../src/modules/payments/payments.service");

    const payment = await paymentsService.create(
      {
        installment_id: installment.id,
        amount_received: 1000,
        payment_method: "CASH",
      },
      { id: collector.id, role: "COLLECTOR" },
    );

    expect(payment.status).toBe("PENDING");
    const reloaded = await pool.query(
      `SELECT id, status FROM payments WHERE id = $1`,
      [payment.id],
    );
    expect(reloaded.rows[0].status).toBe("PENDING");

    jest.dontMock("../../src/modules/notifications/notifications.service");
    jest.resetModules();
  });
});

describe("Hooks de notificaciones — MORA (job overdueInstallments)", () => {
  it("crea una fila en notifications de tipo MORA tras detectar una cuota vencida", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const customer = await createCustomerFixture({ full_name: "Deudor Test" });

    // Cuota vencida hace varios días, sin pre-cargas, status PENDING — candidata a mora.
    const { createCreditFixture } = require("./helpers/fixtures");
    const credit = await createCreditFixture({ customer_id: customer.id });
    await createInstallmentFixture({
      credit_id: credit.id,
      due_date: "2020-01-01",
      original_amount: 1000,
      status: "PENDING",
    });

    const {
      markOverdueAndApplyPenalty,
    } = require("../../src/jobs/overdueInstallments.job");
    await markOverdueAndApplyPenalty();

    const rows = await pool.query(
      `SELECT type, user_id FROM notifications WHERE type = 'MORA'`,
    );
    const forAdmin = rows.rows.find((r) => r.user_id === admin.id);
    expect(forAdmin).toBeDefined();
  });

  it("el job de mora NO falla (sigue marcando OVERDUE) aunque notify() lance un error", async () => {
    await createUserFixture({ role: "ADMIN" });
    const customer = await createCustomerFixture({
      full_name: "Deudor Resiliente",
    });
    const { createCreditFixture } = require("./helpers/fixtures");
    const credit = await createCreditFixture({ customer_id: customer.id });
    const installment = await createInstallmentFixture({
      credit_id: credit.id,
      due_date: "2020-01-01",
      original_amount: 1000,
      status: "PENDING",
    });

    jest.resetModules();
    jest.doMock(
      "../../src/modules/notifications/notifications.service",
      () => ({
        notify: jest
          .fn()
          .mockRejectedValue(new Error("Fallo simulado de notify()")),
      }),
    );

    const {
      markOverdueAndApplyPenalty,
    } = require("../../src/jobs/overdueInstallments.job");
    const result = await markOverdueAndApplyPenalty();

    expect(result.affected_rows).toBeGreaterThanOrEqual(1);

    const reloaded = await pool.query(
      `SELECT status FROM installments WHERE id = $1`,
      [installment.id],
    );
    expect(reloaded.rows[0].status).toBe("OVERDUE");

    jest.dontMock("../../src/modules/notifications/notifications.service");
    jest.resetModules();
  });
});
