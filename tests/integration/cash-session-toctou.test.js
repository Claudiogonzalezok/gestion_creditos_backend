// Bloque T — IMP-2 (post-V4): TOCTOU sobre la caja activa de la jornada
//
// V4: el lock pasa de "caja del usuario" a "caja activa de la jornada"
// (lockActiveSessionByBusinessDay / lockActiveSessionForCurrentJornada).
// El escenario es el mismo de IMP-2: entre el pre-check y el INSERT del
// movimiento, la caja activa puede transicionar (PENDING_RECONCILIATION
// o CLOSED). El re-lookup bajo lock NO la devuelve y el flujo falla 409
// sin imputar nada.

const { pool, setupTestSuite } = require('./helpers/db');
const { createUserFixture }    = require('./helpers/fixtures');
const cashSessionsQueries      = require('../../src/modules/cashSessions/cashSessions.queries');
const cashSessionsService      = require('../../src/modules/cashSessions/cashSessions.service');
const expensesService          = require('../../src/modules/expenses/expenses.service');
const { withTransaction }      = require('../../src/utils/transaction');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

describe('T — TOCTOU sobre la caja activa de la jornada (V4)', () => {
  it('lockActiveSessionByBusinessDay NO devuelve sesiones PENDING_RECONCILIATION', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 0 }, asUser(u));
    await cashSessionsService.markPending(session.id, { reason: 'olvido' }, asUser(u));

    await withTransaction(async (client) => {
      const locked = await cashSessionsQueries.lockActiveSessionByBusinessDay(
        client, session.business_day_id,
      );
      expect(locked).toBeNull();
    });
  });

  it('lockActiveSessionByBusinessDay NO devuelve sesiones CLOSED', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 0 }, asUser(u));
    await cashSessionsService.close(session.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(u));

    await withTransaction(async (client) => {
      const locked = await cashSessionsQueries.lockActiveSessionByBusinessDay(
        client, session.business_day_id,
      );
      expect(locked).toBeNull();
    });
  });

  it('lockActiveSessionForCurrentJornada devuelve null sin caja activa', async () => {
    // No abrimos ninguna caja para que no exista activa.
    await withTransaction(async (client) => {
      const locked = await cashSessionsQueries.lockActiveSessionForCurrentJornada(client);
      expect(locked).toBeNull();
    });
  });

  it('expenses.create falla 409 si la caja activa transicionó a PENDING_RECONCILIATION', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 0 }, asUser(u));

    // Simulamos transición concurrente: marcamos la caja PENDING entre el
    // pre-check (que pasaría) y el flujo transaccional (que debe fallar bajo lock).
    await pool.query(
      `UPDATE cash_sessions
       SET status = 'PENDING_RECONCILIATION',
           pending_reconciliation_at = NOW(),
           pending_reconciliation_reason = 'simulación TOCTOU'
       WHERE id = $1`,
      [session.id],
    );

    await expect(expensesService.create({
      amount: 100, description: 'gasto', payment_method: 'CASH',
    }, asUser(u))).rejects.toMatchObject({
      status: 409,
      code: 'NO_ACTIVE_SESSION',
    });

    // No se persistió el expense.
    const r = await pool.query(`SELECT count(*)::int AS n FROM expenses`);
    expect(r.rows[0].n).toBe(0);
  });
});
