// Bloque T — IMP-2: re-validación bajo lock cierra la ventana TOCTOU entre
// el pre-check de caja OPEN y el INSERT del movimiento.
//
// Escenario: el pre-check ve la caja OPEN, pero entre el lookup y el flujo
// transaccional la caja transiciona (PENDING_RECONCILIATION o CLOSED). El
// re-lookup bajo lock (lockOpenSessionForUser) NO devuelve sesiones que ya no
// estén OPEN, por lo que el flujo falla 409 sin imputar nada.
//
// Simulamos esto cambiando manualmente el status entre dos operaciones del
// mismo usuario (equivalente a una request concurrente que ganó el lock).

const { pool, setupTestSuite } = require('./helpers/db');
const { createUserFixture }    = require('./helpers/fixtures');
const cashSessionsQueries      = require('../../src/modules/cashSessions/cashSessions.queries');
const cashSessionsService      = require('../../src/modules/cashSessions/cashSessions.service');
const expensesService          = require('../../src/modules/expenses/expenses.service');
const { withTransaction }      = require('../../src/utils/transaction');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

describe('T — IMP-2: TOCTOU caja OPEN', () => {
  it('lockOpenSessionForUser NO devuelve sesiones PENDING_RECONCILIATION', async () => {
    const u = await createUserFixture({ role: 'COLLECTOR' });
    const session = await cashSessionsService.open({ opening_amount: 0 }, asUser(u));
    await cashSessionsService.markPending(session.id, { reason: 'olvido' }, asUser(u));

    await withTransaction(async (client) => {
      const locked = await cashSessionsQueries.lockOpenSessionForUser(client, u.id);
      expect(locked).toBeNull();
    });
  });

  it('lockOpenSessionForUser NO devuelve sesiones CLOSED', async () => {
    const u = await createUserFixture({ role: 'COLLECTOR' });
    const session = await cashSessionsService.open({ opening_amount: 0 }, asUser(u));
    await cashSessionsService.close(session.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(u));

    await withTransaction(async (client) => {
      const locked = await cashSessionsQueries.lockOpenSessionForUser(client, u.id);
      expect(locked).toBeNull();
    });
  });

  it('expenses.create falla 409 si la caja transicionó a PENDING_RECONCILIATION', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 0 }, asUser(u));

    // Simulamos transición concurrente: marcamos la caja PENDING entre el
    // pre-check (que pasaría) y el flujo transaccional (que debe fallar bajo lock).
    // Para esto usamos un raw UPDATE en la DB (no hay race real, pero el
    // efecto observado en lockOpenSessionForUser es el mismo).
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
    }, asUser(u))).rejects.toMatchObject({ status: 409 });

    // No se persistió el expense.
    const r = await pool.query(`SELECT count(*)::int AS n FROM expenses`);
    expect(r.rows[0].n).toBe(0);
  });
});
