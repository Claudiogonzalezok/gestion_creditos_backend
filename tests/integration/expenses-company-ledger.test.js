// Issue #50 — editar/eliminar un gasto COMPANY ajusta el saldo de la Caja
// General (cash_accounts.current_balance) con un movimiento compensatorio
// ADJUSTMENT, sin permitir saldo negativo. Los gastos DAILY (caja operativa)
// no tocan la Caja General.

const { pool, setupTestSuite } = require('./helpers/db');
const { createUserFixture }    = require('./helpers/fixtures');
const expensesService          = require('../../src/modules/expenses/expenses.service');
const cashSessionsService      = require('../../src/modules/cashSessions/cashSessions.service');
const { today }                = require('./helpers/dates');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

const generalAccount = async () => {
  const r = await pool.query(
    `SELECT id, current_balance::float8 AS current_balance
       FROM cash_accounts WHERE type = 'GENERAL_CASH' AND is_active = TRUE
      ORDER BY created_at LIMIT 1`,
  );
  return r.rows[0];
};

const setGeneralBalance = async (amount) => {
  const acc = await generalAccount();
  await pool.query(`UPDATE cash_accounts SET current_balance = $2 WHERE id = $1`, [acc.id, amount]);
};

const adjustmentsFor = async (expenseId) => {
  const r = await pool.query(
    `SELECT direction, amount::float8 AS amount
       FROM cash_account_movements
      WHERE movement_type = 'ADJUSTMENT' AND reference_type = 'EXPENSE' AND reference_id = $1
      ORDER BY created_at`,
    [expenseId],
  );
  return r.rows;
};

const companyExpense = (admin, amount) =>
  expensesService.create({
    amount, description: 'proveedor', expense_date: today(),
    payment_method: 'TRANSFER', source: 'COMPANY',
  }, asUser(admin));

describe('#50 — gastos COMPANY ajustan la Caja General', () => {
  it('editar el monto hacia arriba descuenta la diferencia del saldo', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await setGeneralBalance(1000);
    const expense = await companyExpense(admin, 200);
    expect((await generalAccount()).current_balance).toBe(800);

    const updated = await expensesService.update(expense.id, {
      amount: 350, description: 'proveedor', expense_date: today(), payment_method: 'TRANSFER',
    }, asUser(admin));

    expect(updated.amount).toBe(350);
    expect((await generalAccount()).current_balance).toBe(650);
    expect(await adjustmentsFor(expense.id)).toEqual([{ direction: 'OUT', amount: 150 }]);
  });

  it('editar el monto hacia abajo devuelve la diferencia al saldo', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await setGeneralBalance(1000);
    const expense = await companyExpense(admin, 200);

    await expensesService.update(expense.id, {
      amount: 120, description: 'proveedor', expense_date: today(), payment_method: 'TRANSFER',
    }, asUser(admin));

    expect((await generalAccount()).current_balance).toBe(880);
    expect(await adjustmentsFor(expense.id)).toEqual([{ direction: 'IN', amount: 80 }]);
  });

  it('editar sin cambiar el monto no genera movimiento', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await setGeneralBalance(1000);
    const expense = await companyExpense(admin, 200);

    await expensesService.update(expense.id, {
      amount: 200, description: 'otra descripción', expense_date: today(), payment_method: 'TRANSFER',
    }, asUser(admin));

    expect((await generalAccount()).current_balance).toBe(800);
    expect(await adjustmentsFor(expense.id)).toEqual([]);
  });

  it('editar por encima del saldo disponible responde 409 y no cambia nada', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await setGeneralBalance(300);
    const expense = await companyExpense(admin, 200);

    await expect(expensesService.update(expense.id, {
      amount: 500, description: 'proveedor', expense_date: today(), payment_method: 'TRANSFER',
    }, asUser(admin))).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_BALANCE' });

    expect((await generalAccount()).current_balance).toBe(100);
    const r = await pool.query(`SELECT amount::float8 AS amount FROM expenses WHERE id = $1`, [expense.id]);
    expect(r.rows[0].amount).toBe(200);
  });

  it('eliminar devuelve el monto completo al saldo', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await setGeneralBalance(1000);
    const expense = await companyExpense(admin, 200);

    await expensesService.remove(expense.id, asUser(admin));

    expect((await generalAccount()).current_balance).toBe(1000);
    expect(await adjustmentsFor(expense.id)).toEqual([{ direction: 'IN', amount: 200 }]);
  });

  it('no romper: editar un gasto DAILY no toca la Caja General', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    await setGeneralBalance(1000);
    await cashSessionsService.open({ opening_amount: 1000 }, asUser(admin));
    const expense = await expensesService.create({
      amount: 100, description: 'gasto caja', expense_date: today(), payment_method: 'CASH',
    }, asUser(admin));

    const updated = await expensesService.update(expense.id, {
      amount: 175, description: 'gasto caja', expense_date: today(), payment_method: 'CASH',
    }, asUser(admin));
    await expensesService.remove(expense.id, asUser(admin));

    expect(updated.amount).toBe(175);
    expect((await generalAccount()).current_balance).toBe(1000);
    expect(await adjustmentsFor(expense.id)).toEqual([]);
  });
});
