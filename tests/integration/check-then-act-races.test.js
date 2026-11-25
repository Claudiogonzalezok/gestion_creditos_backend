// P26 — issues #43, #47 y #49: carreras check-then-act en jornada, usuarios,
// intentos de cobranza y planillas. Llamadas concurrentes con
// Promise.allSettled; las defensas viven en la base (ON CONFLICT, FOR UPDATE,
// UPDATE condicional), nunca en memoria del proceso.

const { pool, setupTestSuite } = require('./helpers/db');
const {
  createInstallmentFixture,
  createUserFixture,
} = require('./helpers/fixtures');
const { today } = require('./helpers/dates');
const bdQueries = require('../../src/modules/businessDays/businessDays.queries');
const businessDaysService = require('../../src/modules/businessDays/businessDays.service');
const cashSessionsService = require('../../src/modules/cashSessions/cashSessions.service');
const usersService = require('../../src/modules/users/users.service');
const attemptsService = require('../../src/modules/collectionAttempts/collectionAttempts.service');
const usersQueries = require('../../src/modules/users/users.queries');
const attemptsQueries = require('../../src/modules/collectionAttempts/collectionAttempts.queries');

setupTestSuite();

/**
 * Fuerza el peor intercalado posible: las dos llamadas concurrentes esperan
 * a que ambas hayan hecho la lectura del "check" antes de seguir al "act".
 * Si la segunda queda bloqueada por un lock de BD, la primera sigue tras un
 * timeout corto (así el test no se cuelga cuando la defensa funciona).
 * @param {object} mod - módulo de queries a espiar.
 * @param {string} fnName - función de lectura del check.
 */
const barrierOn = (mod, fnName) => {
  const original = mod[fnName];
  let arrived = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  return jest.spyOn(mod, fnName).mockImplementation(async (...args) => {
    const value = await original(...args);
    arrived += 1;
    if (arrived >= 2) release();
    await Promise.race([gate, new Promise((r) => setTimeout(r, 300))]);
    return value;
  });
};

afterEach(() => jest.restoreAllMocks());

const asUser = (u) => ({ id: u.id, role: u.role });

const twice = (fn) => Promise.allSettled([fn(), fn()]);

const outcome = (results) => ({
  ok: results.filter((r) => r.status === 'fulfilled').length,
  conflicts: results.filter((r) => r.status === 'rejected' && r.reason?.status === 409).length,
});

const defaultBranchId = async () => (await bdQueries.findDefaultBranch()).id;

describe('#43 — creación concurrente de la jornada', () => {
  it('dos transacciones crean la misma jornada: ambas obtienen la misma fila sin abortar', async () => {
    const branchId = await defaultBranchId();
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const first = await bdQueries.create(a, { businessDate: today(), branchId });
      // b queda bloqueada por el índice único hasta que a confirme.
      const secondPromise = bdQueries.create(b, { businessDate: today(), branchId });
      await a.query('COMMIT');
      const second = await secondPromise;
      // La transacción de b sigue usable (no quedó en 25P02).
      const check = await b.query('SELECT 1 AS ok');
      await b.query('COMMIT');

      expect(second.id).toBe(first.id);
      expect(check.rows[0].ok).toBe(1);
    } finally {
      await a.query('ROLLBACK').catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }
    const n = await pool.query(`SELECT COUNT(*)::int AS n FROM business_days`);
    expect(n.rows[0].n).toBe(1);
  });

  it('dos aperturas de caja simultáneas: una abre, la otra 409 (nunca 500)', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const res = outcome(await twice(() =>
      cashSessionsService.open({ opening_amount: 0 }, asUser(admin))));

    expect(res).toEqual({ ok: 1, conflicts: 1 });
    const n = await pool.query(`SELECT COUNT(*)::int AS n FROM business_days`);
    expect(n.rows[0].n).toBe(1);
  });

  it('no romper: apertura normal de jornada', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 100 }, asUser(admin));
    const day = await bdQueries.findById(session.business_day_id);
    expect(day.status).toBe('OPEN');
  });
});

describe('#47 — force-close conserva observaciones', () => {
  const openDayWithSession = async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 0 }, asUser(admin));
    return { admin, dayId: session.business_day_id };
  };

  it('las observaciones previas se conservan con la línea [FORCE-CLOSE] agregada', async () => {
    const { admin, dayId } = await openDayWithSession();
    await pool.query(`UPDATE business_days SET observations = 'nota previa' WHERE id = $1`, [dayId]);

    const day = await businessDaysService.forceClose(dayId, { reason: 'fin de día' }, asUser(admin));

    expect(day.status).toBe('CLOSED');
    expect(day.observations).toMatch(/^nota previa\n\[FORCE-CLOSE\] fin de día/);
  });

  it('no romper: sin observaciones previas queda solo la línea [FORCE-CLOSE]', async () => {
    const { admin, dayId } = await openDayWithSession();
    const day = await businessDaysService.forceClose(dayId, { reason: 'x' }, asUser(admin));
    expect(day.observations).toMatch(/^\[FORCE-CLOSE\] x/);
  });
});

describe('#49 — usuarios, intentos y planillas', () => {
  it('dos admins se desactivan mutuamente en paralelo: queda al menos uno activo', async () => {
    const a1 = await createUserFixture({ role: 'ADMIN' });
    const a2 = await createUserFixture({ role: 'ADMIN' });
    barrierOn(usersQueries, 'countActiveAdmins');

    const results = await Promise.allSettled([
      usersService.deactivate(a1.id),
      usersService.deactivate(a2.id),
    ]);

    expect(outcome(results)).toEqual({ ok: 1, conflicts: 1 });
    const n = await pool.query(
      `SELECT COUNT(*)::int AS n FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'`,
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('no romper: desactivar un admin cuando hay otro activo', async () => {
    const a1 = await createUserFixture({ role: 'ADMIN' });
    await createUserFixture({ role: 'ADMIN' });
    await usersService.deactivate(a1.id);
    const r = await pool.query(`SELECT status FROM users WHERE id = $1`, [a1.id]);
    expect(r.rows[0].status).toBe('INACTIVE');
  });

  it('alta concurrente con el mismo DNI: una crea, la otra 409', async () => {
    barrierOn(usersQueries, 'findByDni');
    const res = outcome(await twice(() => usersService.create({
      full_name: 'Duplicado', dni: '30111222', role: 'SELLER',
    })));
    expect(res).toEqual({ ok: 1, conflicts: 1 });
  });

  it('anular el mismo intento dos veces en paralelo: uno anula, el otro 409', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const inst = await createInstallmentFixture({ status: 'PENDING' });
    const attempt = await attemptsService.create({
      installment_id: inst.id, attempt_type: 'NOT_FOUND',
    }, asUser(admin));
    barrierOn(attemptsQueries, 'findRawById');

    const res = outcome(await twice(() => attemptsService.voidAttempt(attempt.id, asUser(admin))));

    expect(res).toEqual({ ok: 1, conflicts: 1 });
    const r = await pool.query(
      `SELECT voided_at IS NOT NULL AS voided FROM collection_attempts WHERE id = $1`,
      [attempt.id],
    );
    expect(r.rows[0].voided).toBe(true);
  });

  it('no romper: anulación individual del mismo día', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const inst = await createInstallmentFixture({ status: 'PENDING' });
    const attempt = await attemptsService.create({
      installment_id: inst.id, attempt_type: 'NOT_FOUND',
    }, asUser(admin));
    const voided = await attemptsService.voidAttempt(attempt.id, asUser(admin));
    expect(voided.voided_at).not.toBeNull();
  });

  it('el día de anulación lo decide la fecha de la BD: intento de ayer → 409', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const inst = await createInstallmentFixture({ status: 'PENDING' });
    const attempt = await attemptsService.create({
      installment_id: inst.id, attempt_type: 'NOT_FOUND',
    }, asUser(admin));
    await pool.query(
      `UPDATE collection_attempts SET created_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
      [attempt.id],
    );
    await expect(attemptsService.voidAttempt(attempt.id, asUser(admin)))
      .rejects.toMatchObject({ status: 409 });
  });
});
