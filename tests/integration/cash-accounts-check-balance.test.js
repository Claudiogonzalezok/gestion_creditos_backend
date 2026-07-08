// Bloque R — Auditoría CRIT-3: defensa en profundidad para current_balance.
//
// La regla "saldo nunca negativo" se valida en el service con 409
// INSUFFICIENT_BALANCE. La migración 026 agrega un CHECK constraint en DB
// como red de contención: cualquier UPDATE directo que intente dejar
// cash_accounts.current_balance en negativo debe ser rechazado por Postgres.

const { pool, setupTestSuite }  = require('./helpers/db');
const cashAccountsQueries       = require('../../src/modules/cashAccounts/cashAccounts.queries');

setupTestSuite();

describe('R — CRIT-3: CHECK constraint current_balance >= 0', () => {
  it('UPDATE directo a saldo negativo es rechazado por la DB', async () => {
    const acc = await cashAccountsQueries.findGeneralCashAccount();
    await expect(
      pool.query(`UPDATE cash_accounts SET current_balance = -10 WHERE id = $1`, [acc.id]),
    ).rejects.toMatchObject({
      code: '23514',  // check_violation
      constraint: 'chk_cash_accounts_current_balance_nonneg',
    });

    // El balance no se tocó.
    const bal = await pool.query(`SELECT current_balance FROM cash_accounts WHERE id = $1`, [acc.id]);
    expect(parseFloat(bal.rows[0].current_balance)).toBe(0);
  });

  it('UPDATE a 0 (borde) y positivo se permite', async () => {
    const acc = await cashAccountsQueries.findGeneralCashAccount();
    await pool.query(`UPDATE cash_accounts SET current_balance = 0 WHERE id = $1`, [acc.id]);
    await pool.query(`UPDATE cash_accounts SET current_balance = 1000.50 WHERE id = $1`, [acc.id]);
    const bal = await pool.query(`SELECT current_balance FROM cash_accounts WHERE id = $1`, [acc.id]);
    expect(parseFloat(bal.rows[0].current_balance)).toBe(1000.50);
  });

  it('INSERT con current_balance negativo es rechazado', async () => {
    await expect(
      pool.query(
        `INSERT INTO cash_accounts (name, type, current_balance) VALUES ('X','GENERAL_CASH',-1)`,
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'chk_cash_accounts_current_balance_nonneg',
    });
  });
});
