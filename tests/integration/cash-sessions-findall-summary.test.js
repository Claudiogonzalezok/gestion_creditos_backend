// Bloque F2-0 — enriquecimiento de findAll cash-sessions con summary.
//
// Verifica que GET /api/cash-sessions?business_day_id=X devuelve:
//   · shift_label
//   · summary { collections, expenses, drops, difference } (objeto JSONB)
//     · NULL en sesiones OPEN/PENDING sin snapshot.
//     · Totales correctos en sesiones CLOSED (extraídos del closure_snapshot).
//
// El objetivo del summary es que el frontend no consuma closure_snapshot
// directamente — así la API queda estable cuando el snapshot evolucione a v2
// o aparezcan nuevos métodos de pago.

const { pool, setupTestSuite }   = require('./helpers/db');
const { createUserFixture,
        createCustomerFixture,
        createCreditFixture,
        createInstallmentFixture } = require('./helpers/fixtures');
const cashSessionsQueries        = require('../../src/modules/cashSessions/cashSessions.queries');
const cashSessionsService        = require('../../src/modules/cashSessions/cashSessions.service');
const paymentsService            = require('../../src/modules/payments/payments.service');
const expensesService            = require('../../src/modules/expenses/expenses.service');
const { today }                  = require('./helpers/dates');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

describe('F2-0 — findAll cash-sessions con summary + shift_label', () => {
  it('sesión OPEN: summary = null, shift_label se preserva', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const s = await cashSessionsService.open(
      { opening_amount: 1000 }, asUser(u),
    );
    // Setear shift_label manualmente (V4.4 lo agregó en schema; la apertura
    // todavía no lo soporta en el payload del service — eso se ajustará
    // cuando el frontend lo necesite).
    await pool.query(
      `UPDATE cash_sessions SET shift_label = $2 WHERE id = $1`,
      [s.id, 'Mañana'],
    );

    const rows = await cashSessionsQueries.findAll({ businessDayId: s.business_day_id });
    expect(rows).toHaveLength(1);
    expect(rows[0].shift_label).toBe('Mañana');
    expect(rows[0].summary).toBeNull();
  });

  it('sesión CLOSED: summary tiene los totales del cierre', async () => {
    const admin     = await createUserFixture({ role: 'ADMIN' });
    const collector = await createUserFixture({ role: 'COLLECTOR' });
    const customer  = await createCustomerFixture();
    const credit    = await createCreditFixture({
      customer_id: customer.id, type: 'LOAN', total_amount: 1000,
    });
    const inst = await createInstallmentFixture({
      credit_id: credit.id, due_date: today(),
      original_amount: 1000, amount_paid: 0, status: 'PENDING',
    });

    // Admin abre caja, cobrador pre-carga, admin aprueba, admin gasta, dropea, cierra.
    const session = await cashSessionsService.open(
      { opening_amount: 500 }, asUser(admin),
    );

    const payment = await paymentsService.create({
      installment_id:  inst.id,
      amount_received: 800,
      payment_method:  'CASH',
      next_visit_date: today(),
    }, asUser(collector));
    await paymentsService.approve(payment.id, admin.id);

    await expensesService.create({
      amount: 50, description: 'Combustible',
      expense_date: today(), payment_method: 'CASH',
    }, asUser(admin));

    await cashSessionsService.addDrop(session.id, {
      amount: 300, payment_method: 'CASH',
    }, asUser(admin));

    await cashSessionsService.close(session.id, {
      declared: [
        { payment_method: 'CASH',     declared_amount: 950 },  // 500 + 800 - 50 - 300
        { payment_method: 'TRANSFER', declared_amount: 0 },
      ],
    }, asUser(admin));

    const rows = await cashSessionsQueries.findAll({ businessDayId: session.business_day_id });
    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(row.status).toBe('CLOSED');
    expect(row.summary).not.toBeNull();
    expect(row.summary).toMatchObject({
      collections: 800,    // payments 800, down_payments 0
      expenses:    50,
      drops:       300,
      difference:  0,      // declarado exacto
    });
  });

  it('summary refleja descuadre cuando declared difiere de expected', async () => {
    const admin     = await createUserFixture({ role: 'ADMIN' });
    const collector = await createUserFixture({ role: 'COLLECTOR' });
    const customer  = await createCustomerFixture();
    const credit    = await createCreditFixture({
      customer_id: customer.id, type: 'LOAN', total_amount: 1000,
    });
    const inst = await createInstallmentFixture({
      credit_id: credit.id, due_date: today(),
      original_amount: 1000, amount_paid: 0, status: 'PENDING',
    });

    const session = await cashSessionsService.open(
      { opening_amount: 0 }, asUser(admin),
    );
    const payment = await paymentsService.create({
      installment_id: inst.id, amount_received: 1000, payment_method: 'CASH',
      next_visit_date: today(),
    }, asUser(collector));
    await paymentsService.approve(payment.id, admin.id);

    // Declaro 990 → faltan 10.
    await cashSessionsService.close(session.id, {
      declared: [
        { payment_method: 'CASH', declared_amount: 990 },
      ],
    }, asUser(admin));

    const rows = await cashSessionsQueries.findAll({ businessDayId: session.business_day_id });
    expect(rows[0].summary.difference).toBe(-10);
  });

  it('contrato: closure_snapshot NO se expone en el listado', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const s = await cashSessionsService.open({ opening_amount: 0 }, asUser(u));
    await cashSessionsService.close(s.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(u));

    const rows = await cashSessionsQueries.findAll({ businessDayId: s.business_day_id });
    expect(rows[0]).not.toHaveProperty('closure_snapshot');
    // Pero sí está el summary derivado.
    expect(rows[0].summary).not.toBeNull();
  });
});
