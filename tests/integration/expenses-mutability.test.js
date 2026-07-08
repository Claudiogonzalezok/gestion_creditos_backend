// Bloque S — IMP-7: expenses.update/remove respeta el cierre de la
// cash_session (no solo cash_registers legacy).
//
// Post-Fase 2, cada expense tiene cash_session_id. Cuando esa sesión pasa a
// CLOSED, el gasto queda inmutable. Antes solo se chequeaba el legacy
// cash_registers, que podía no existir aunque la caja Fase 2 estuviera cerrada.

const { pool, setupTestSuite } = require('./helpers/db');
const { createUserFixture }    = require('./helpers/fixtures');
const expensesService          = require('../../src/modules/expenses/expenses.service');
const cashSessionsService      = require('../../src/modules/cashSessions/cashSessions.service');
const { today }                = require('./helpers/dates');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

describe('S — IMP-7: expenses respeta cash_sessions.status', () => {
  it('update bloqueado con 409 si la cash_session está CLOSED', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 1000 }, asUser(admin));

    const expense = await expensesService.create({
      amount: 200, description: 'gasto X',
      expense_date: today(), payment_method: 'CASH',
    }, asUser(admin));

    // Cerrar la caja del admin.
    await cashSessionsService.close(session.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 800 }],
    }, asUser(admin));

    await expect(expensesService.update(expense.id, {
      amount: 300, description: 'modificado', payment_method: 'CASH',
    })).rejects.toMatchObject({ status: 409 });
  });

  it('remove bloqueado con 409 si la cash_session está CLOSED', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 1000 }, asUser(admin));

    const expense = await expensesService.create({
      amount: 150, description: 'gasto Y',
      expense_date: today(), payment_method: 'CASH',
    }, asUser(admin));

    await cashSessionsService.close(session.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 850 }],
    }, asUser(admin));

    await expect(expensesService.remove(expense.id))
      .rejects.toMatchObject({ status: 409 });

    // El expense sigue existiendo
    const r = await pool.query(`SELECT id FROM expenses WHERE id = $1`, [expense.id]);
    expect(r.rows.length).toBe(1);
  });

  it('update permitido con caja OPEN', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await cashSessionsService.open({ opening_amount: 1000 }, asUser(admin));

    const expense = await expensesService.create({
      amount: 100, description: 'gasto Z',
      expense_date: today(), payment_method: 'CASH',
    }, asUser(admin));

    const updated = await expensesService.update(expense.id, {
      amount: 175, description: 'modificado OK',
      expense_date: today(), payment_method: 'CASH',
    });
    expect(updated.amount).toBe(175);
  });
});
