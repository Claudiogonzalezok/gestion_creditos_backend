// Bloque V4-B — invariante de DB "una OPEN por business_day" (migración 027)
//
// V4.5: el unique partial index sobre cash_sessions(business_day_id) WHERE
// status='OPEN' es la red de seguridad última. El service ya bloquea (V4.4)
// con 409 ACTIVE_SESSION_IN_BUSINESS_DAY, pero un INSERT directo o una race
// extrema deben ser rechazados por la DB.

const { pool, setupTestSuite } = require('./helpers/db');
const { createUserFixture }    = require('./helpers/fixtures');
const cashSessionsService      = require('../../src/modules/cashSessions/cashSessions.service');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

describe('V4-B — invariante DB "una OPEN por business_day" (migración 027)', () => {
  it('el índice único parcial bloquea dos cajas OPEN en la misma jornada (INSERT directo)', async () => {
    const u1 = await createUserFixture({ role: 'ADMIN' });
    const u2 = await createUserFixture({ role: 'ADMIN' });
    const s1 = await cashSessionsService.open({ opening_amount: 0 }, asUser(u1));

    // INSERT bypaseando el service. Debe fallar por el unique partial index.
    await expect(pool.query(
      `INSERT INTO cash_sessions
         (business_day_id, owner_user_id, opened_by, opening_amount, status)
       VALUES ($1, $2, $2, 0, 'OPEN')`,
      [s1.business_day_id, u2.id],
    )).rejects.toMatchObject({
      code: '23505',
      constraint: 'one_open_session_per_business_day_idx',
    });
  });

  it('el índice NO bloquea cajas CLOSED en la misma jornada (partial WHERE status=OPEN)', async () => {
    const u1 = await createUserFixture({ role: 'ADMIN' });
    const u2 = await createUserFixture({ role: 'ADMIN' });
    const s1 = await cashSessionsService.open({ opening_amount: 0 }, asUser(u1));
    await cashSessionsService.close(s1.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(u1));

    // Segunda apertura en la misma jornada (s1 cerrada) → permitida.
    const s2 = await cashSessionsService.open({ opening_amount: 0 }, asUser(u2));
    expect(s2.business_day_id).toBe(s1.business_day_id);
    expect(s2.status).toBe('OPEN');
  });

  it('el índice anterior por owner_user_id no existe', async () => {
    const r = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE tablename='cash_sessions' AND indexname='one_open_session_per_owner_idx'`,
    );
    expect(r.rows.length).toBe(0);
  });

  it('el índice nuevo por business_day_id existe', async () => {
    const r = await pool.query(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename='cash_sessions' AND indexname='one_open_session_per_business_day_idx'`,
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].indexdef).toMatch(/business_day_id/);
    expect(r.rows[0].indexdef).toMatch(/WHERE.*OPEN/);
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
