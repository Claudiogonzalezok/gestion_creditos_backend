// Bloque V4-B — invariante de DB "una sola caja por business_day, siempre" (migración 037)
//
// V4.5 (migración 027) tenía un unique PARTIAL index (WHERE status='OPEN'):
// permitía a propósito abrir una segunda caja una vez cerrada la primera
// (turnos secuenciales). El negocio descartó esa flexibilidad — la migración
// 037 lo reemplazó por un índice único TOTAL sobre business_day_id, sin
// filtro de status. El service ya bloquea (V4.6) con 409
// ACTIVE_SESSION_IN_BUSINESS_DAY antes de llegar a la DB; este archivo
// verifica que la constraint de DB también lo endurece como red de
// seguridad última (INSERT directo o race extrema).

const { pool, setupTestSuite } = require('./helpers/db');
const { createUserFixture }    = require('./helpers/fixtures');
const cashSessionsService      = require('../../src/modules/cashSessions/cashSessions.service');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

describe('V4-B — invariante DB "una sola caja por business_day, siempre" (migración 037)', () => {
  it('el índice único total bloquea una segunda caja OPEN en la misma jornada (INSERT directo)', async () => {
    const u1 = await createUserFixture({ role: 'ADMIN' });
    const u2 = await createUserFixture({ role: 'ADMIN' });
    const s1 = await cashSessionsService.open({ opening_amount: 0 }, asUser(u1));

    // INSERT bypaseando el service. Debe fallar por el unique index total.
    await expect(pool.query(
      `INSERT INTO cash_sessions
         (business_day_id, owner_user_id, opened_by, opening_amount, status)
       VALUES ($1, $2, $2, 0, 'OPEN')`,
      [s1.business_day_id, u2.id],
    )).rejects.toMatchObject({
      code: '23505',
      constraint: 'one_session_per_business_day_idx',
    });
  });

  it('el índice también bloquea una segunda caja PENDING_RECONCILIATION en la misma jornada (sin filtro de status, INSERT directo)', async () => {
    const u1 = await createUserFixture({ role: 'ADMIN' });
    const u2 = await createUserFixture({ role: 'ADMIN' });
    const s1 = await cashSessionsService.open({ opening_amount: 0 }, asUser(u1));
    await cashSessionsService.close(s1.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(u1));

    // Migración 037: el índice es TOTAL, no parcial — bloquea incluso una
    // segunda fila de otro status (acá PENDING_RECONCILIATION, no CLOSED,
    // para no chocar con el CHECK cash_sessions_closed_integrity de la 023
    // que exige closed_at/closed_by/closure_snapshot) para el mismo
    // business_day_id.
    await expect(pool.query(
      `INSERT INTO cash_sessions
         (business_day_id, owner_user_id, opened_by, opening_amount, status,
          pending_reconciliation_at, pending_reconciliation_reason)
       VALUES ($1, $2, $2, 0, 'PENDING_RECONCILIATION', NOW(), 'test')`,
      [s1.business_day_id, u2.id],
    )).rejects.toMatchObject({
      code: '23505',
      constraint: 'one_session_per_business_day_idx',
    });
  });

  it('el índice anterior por owner_user_id no existe', async () => {
    const r = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE tablename='cash_sessions' AND indexname='one_open_session_per_owner_idx'`,
    );
    expect(r.rows.length).toBe(0);
  });

  it('el índice parcial de la migración 027 ya no existe', async () => {
    const r = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE tablename='cash_sessions' AND indexname='one_open_session_per_business_day_idx'`,
    );
    expect(r.rows.length).toBe(0);
  });

  it('el índice total nuevo por business_day_id existe, sin filtro de status', async () => {
    const r = await pool.query(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename='cash_sessions' AND indexname='one_session_per_business_day_idx'`,
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].indexdef).toMatch(/business_day_id/);
    expect(r.rows[0].indexdef).not.toMatch(/WHERE/);
  });

  it('shift_label es opcional y se preserva si se setea por SQL directo', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const s = await cashSessionsService.open({ opening_amount: 0 }, asUser(u));
    await pool.query(
      `UPDATE cash_sessions SET shift_label = $2 WHERE id = $1`,
      [s.id, 'Mañana'],
    );
    const r = await pool.query(`SELECT shift_label FROM cash_sessions WHERE id = $1`, [s.id]);
    expect(r.rows[0].shift_label).toBe('Mañana');
  });
});
