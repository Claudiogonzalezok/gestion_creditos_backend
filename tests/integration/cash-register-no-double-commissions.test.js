// Bloque Q — Auditoría CRIT-1: el dashboard legacy NO debe contar las
// commission_liquidations como egreso del día.
//
// Post-Fase 3, las liquidaciones se imputan a Caja General (cash_account_movements
// / SALARY_PAYMENT). Si el dashboard legacy las sigue restando, se produce un
// doble-cómputo: el egreso aparece como salida del día Y como descuento de
// tesorería al mismo tiempo.

const { pool, setupTestSuite }   = require('./helpers/db');
const { createUserFixture }      = require('./helpers/fixtures');
const cashRegisterQueries        = require('../../src/modules/cashRegister/cashRegister.queries');
const cashAccountsService        = require('../../src/modules/cashAccounts/cashAccounts.service');
const cashAccountsQueries        = require('../../src/modules/cashAccounts/cashAccounts.queries');
const commissionsService         = require('../../src/modules/commissions/commissions.service');
const { localDate }              = require('../../src/utils/date');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

const seedPendingCommission = async (userId, amount) => {
  const cust = (await pool.query(
    `INSERT INTO customers (full_name, dni, status) VALUES ('Cli','${String(Date.now()).slice(-9)}','ACTIVE') RETURNING id`,
  )).rows[0];
  const cred = (await pool.query(
    `INSERT INTO credits (customer_id, type, total_amount, installments_count, payment_frequency, status, created_by)
     VALUES ($1, 'SALE', 10000, 1, 'WEEKLY', 'ACTIVE', $2) RETURNING id`,
    [cust.id, userId],
  )).rows[0];
  await pool.query(
    `INSERT INTO commissions (user_id, credit_id, amount, status, week_start, week_end)
     VALUES ($1, $2, $3, 'PENDING', '2026-06-01', '2026-06-07')`,
    [userId, cred.id, amount],
  );
};

describe('Q — Auditoría CRIT-1: dashboard legacy NO debe doble-contar commissions', () => {
  it('liquidate post-Fase 3 NO aparece en total_outflows del dashboard', async () => {
    const acc       = await cashAccountsQueries.findGeneralCashAccount();
    const admin     = await createUserFixture({ role: 'ADMIN' });
    const collector = await createUserFixture({ role: 'COLLECTOR' });

    // Cargar Caja General y liquidar comisión de $750.
    await cashAccountsService.registerMovement(acc.id, {
      movementType: 'ADJUSTMENT', direction: 'IN', amount: 3000,
    }, asUser(admin));
    await seedPendingCommission(collector.id, 750);
    const liq = await commissionsService.liquidate({
      user_id: collector.id, payment_method: 'CASH',
    }, admin.id);
    expect(liq.total_paid).toBe(750);

    // Dashboard del día NO debe contar la liquidación como egreso operativo.
    const date      = localDate();
    const dashboard = await cashRegisterQueries.getDashboard(date);
    expect(dashboard.total_outflows).toBe(0); // sin expenses ni commissions
    expect(dashboard.net_balance).toBe(0);    // sin cobros ni egresos del día
  });

  it('getDailyTotals devuelve commissions_cash/transfer en 0 y no las resta del neto', async () => {
    const acc       = await cashAccountsQueries.findGeneralCashAccount();
    const admin     = await createUserFixture({ role: 'ADMIN' });
    const collector = await createUserFixture({ role: 'COLLECTOR' });

    await cashAccountsService.registerMovement(acc.id, {
      movementType: 'ADJUSTMENT', direction: 'IN', amount: 2000,
    }, asUser(admin));
    await seedPendingCommission(collector.id, 600);
    await commissionsService.liquidate({
      user_id: collector.id, payment_method: 'CASH',
    }, admin.id);

    const date   = localDate();
    const totals = await cashRegisterQueries.getDailyTotals(date);
    expect(totals.commissions_cash).toBe(0);
    expect(totals.commissions_transfer).toBe(0);
    expect(totals.total_outflows).toBe(0);   // sin expenses
    expect(totals.cash_amount).toBe(0);      // 0 ingresos - 0 egresos
  });

  it('getPreClose devuelve comisiones en 0 y no las suma a total_egresos ni esperado', async () => {
    const acc       = await cashAccountsQueries.findGeneralCashAccount();
    const admin     = await createUserFixture({ role: 'ADMIN' });
    const collector = await createUserFixture({ role: 'COLLECTOR' });

    await cashAccountsService.registerMovement(acc.id, {
      movementType: 'ADJUSTMENT', direction: 'IN', amount: 1000,
    }, asUser(admin));
    await seedPendingCommission(collector.id, 400);
    await commissionsService.liquidate({
      user_id: collector.id, payment_method: 'CASH',
    }, admin.id);

    const date     = localDate();
    const preClose = await cashRegisterQueries.getPreClose(date);
    expect(preClose.comisiones_efectivo).toBe(0);
    expect(preClose.comisiones_transferencia).toBe(0);
    expect(preClose.total_egresos).toBe(0);
    expect(preClose.efectivo_esperado).toBe(0);
    expect(preClose.transferencia_esperada).toBe(0);
  });

  it('Caja General SÍ descontó el monto liquidado (única fuente de verdad)', async () => {
    const acc       = await cashAccountsQueries.findGeneralCashAccount();
    const admin     = await createUserFixture({ role: 'ADMIN' });
    const collector = await createUserFixture({ role: 'COLLECTOR' });

    await cashAccountsService.registerMovement(acc.id, {
      movementType: 'ADJUSTMENT', direction: 'IN', amount: 5000,
    }, asUser(admin));
    await seedPendingCommission(collector.id, 800);
    await commissionsService.liquidate({
      user_id: collector.id, payment_method: 'CASH',
    }, admin.id);

    const bal = await cashAccountsService.getBalance(acc.id);
    expect(bal.current_balance).toBe(4200); // 5000 - 800
  });
});
