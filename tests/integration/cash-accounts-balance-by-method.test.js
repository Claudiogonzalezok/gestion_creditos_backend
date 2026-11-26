// Issue #93 — saldo de Caja General separado por medio (efectivo/transferencia).

const { pool, setupTestSuite } = require('./helpers/db');
const { createUserFixture } = require('./helpers/fixtures');
const cashAccountsService = require('../../src/modules/cashAccounts/cashAccounts.service');
const cashAccountsQueries = require('../../src/modules/cashAccounts/cashAccounts.queries');
const { withTransaction } = require('../../src/utils/transaction');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

// Caja con 1000 en efectivo y 500 en transferencia (ejemplo del issue).
const seed = async () => {
  const acc = await cashAccountsQueries.findGeneralCashAccount();
  const admin = await createUserFixture({ role: 'ADMIN' });
  await cashAccountsService.registerMovement(
    acc.id,
    { movementType: 'MANUAL_INCOME', amount_cash: 1000, amount_transfer: 500 },
    asUser(admin),
  );
  return { acc, admin };
};

describe('#93 — saldo de Caja General por medio', () => {
  it('1000 efectivo + 500 transferencia → cash 1000, transfer 500, current 1500', async () => {
    const { acc } = await seed();
    const bal = await cashAccountsService.getBalance(acc.id);
    expect(bal).toMatchObject({
      current_balance: 1500,
      cash_balance: 1000,
      transfer_balance: 500,
    });
  });

  it('convertir 1200 de efectivo a transferencia → 409 INSUFFICIENT_METHOD_BALANCE', async () => {
    const { acc } = await seed();
    await expect(
      withTransaction((client) =>
        cashAccountsService.assertMethodAvailable(client, acc.id, 'CASH', 1200),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_METHOD_BALANCE' });

    // 1000 de efectivo sí alcanza.
    const ok = await withTransaction((client) =>
      cashAccountsService.assertMethodAvailable(client, acc.id, 'CASH', 1000),
    );
    expect(ok).toEqual({ cash_balance: 1000, transfer_balance: 500 });
  });

  it('conversiones COMPANY mueven saldo entre medios sin cambiar el total', async () => {
    const { acc, admin } = await seed();
    await pool.query(
      `INSERT INTO cash_conversions (register_date, criteria, source_method, target_method, amount, created_by)
       VALUES (CURRENT_DATE, 'COMPANY', 'CASH', 'TRANSFER', 300, $1),
              (CURRENT_DATE, 'DAILY',   'CASH', 'TRANSFER', 999, $1)`,
      [admin.id],
    );
    const bal = await cashAccountsService.getBalance(acc.id);
    expect(bal).toMatchObject({
      current_balance: 1500,
      cash_balance: 700,
      transfer_balance: 800,
    });
  });

  it('egreso OUT por transferencia mayor al saldo del medio → 409 y no persiste', async () => {
    const { acc, admin } = await seed();
    await expect(
      cashAccountsService.registerMovement(
        acc.id,
        { movementType: 'EXPENSE', amount_transfer: 600 },
        asUser(admin),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_METHOD_BALANCE' });

    const bal = await cashAccountsService.getBalance(acc.id);
    expect(bal.current_balance).toBe(1500);
  });

  it('egreso OUT con desglose válido descuenta de cada medio', async () => {
    const { acc, admin } = await seed();
    const r = await cashAccountsService.registerMovement(
      acc.id,
      { movementType: 'SUPPLIER_PAYMENT', amount_cash: 200, amount_transfer: 100 },
      asUser(admin),
    );
    expect(r.current_balance).toBe(1200);
    expect(r.movement).toMatchObject({ direction: 'OUT', amount_cash: 200, amount_transfer: 100 });
    const bal = await cashAccountsService.getBalance(acc.id);
    expect(bal).toMatchObject({ cash_balance: 800, transfer_balance: 400 });
  });

  it('egreso OUT sin desglose (retrocompatible) solo valida el total y se imputa a efectivo', async () => {
    const { acc, admin } = await seed();
    await cashAccountsService.registerMovement(
      acc.id,
      { movementType: 'EXPENSE', amount: 1200 },
      asUser(admin),
    );
    const bal = await cashAccountsService.getBalance(acc.id);
    expect(bal).toMatchObject({
      current_balance: 300,
      cash_balance: -200,
      transfer_balance: 500,
    });
  });

  it('redondeo exacto de montos (issue #39): 1.005 de efectivo se guarda como 1.01', async () => {
    const acc = await cashAccountsQueries.findGeneralCashAccount();
    const admin = await createUserFixture({ role: 'ADMIN' });
    const r = await cashAccountsService.registerMovement(
      acc.id,
      { movementType: 'MANUAL_INCOME', amount_cash: '1.005', amount_transfer: '0' },
      asUser(admin),
    );
    expect(r.current_balance).toBe(1.01);
  });
});
