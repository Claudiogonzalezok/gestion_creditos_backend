// Bloque M — Jornadas (business_days)
// Verifica la máquina de estados OPEN → READY_TO_CLOSE → CLOSED → AUDITED y la
// creación automática al abrir la primera caja del día.

const { pool, setupTestSuite } = require('./helpers/db');
const { createUserFixture } = require('./helpers/fixtures');
const cashSessions = require('../../src/modules/cashSessions/cashSessions.service');
const businessDays = require('../../src/modules/businessDays/businessDays.service');
const businessDaysQueries = require('../../src/modules/businessDays/businessDays.queries');

setupTestSuite();

const asUser = (user) => ({ id: user.id, role: user.role });

describe('M — Jornadas (business_days)', () => {
  it('la primera apertura del día crea la jornada en OPEN', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const s = await cashSessions.open({ opening_amount: 0 }, asUser(u));
    expect(s.business_day.status).toBe('OPEN');
    expect(s.business_day.id).toBeDefined();
  });

  it('V4: aperturas secuenciales del mismo día apuntan a la misma jornada', async () => {
    // V4: una OPEN por jornada. La segunda apertura se hace tras cerrar la
    // primera (turnos multi-cajero secuenciales son válidos).
    const u1 = await createUserFixture({ role: 'ADMIN' });
    const u2 = await createUserFixture({ role: 'ADMIN' });
    const s1 = await cashSessions.open({ opening_amount: 0 }, asUser(u1));
    await cashSessions.close(s1.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(u1));
    const s2 = await cashSessions.open({ opening_amount: 0 }, asUser(u2));
    expect(s1.business_day_id).toBe(s2.business_day_id);
  });

  it('V4: transición OPEN → READY_TO_CLOSE cuando la última caja cierra', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const s = await cashSessions.open({ opening_amount: 0 }, asUser(u));

    // Mientras la caja esté OPEN, la jornada está OPEN.
    let day = await businessDaysQueries.findById(s.business_day_id);
    expect(day.status).toBe('OPEN');

    await cashSessions.close(s.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(u));

    day = await businessDaysQueries.findById(s.business_day_id);
    expect(day.status).toBe('READY_TO_CLOSE');
    expect(day.ready_to_close_at).not.toBeNull();
  });

  it('V4: caja PENDING_RECONCILIATION bloquea la transición a READY_TO_CLOSE', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const s = await cashSessions.open({ opening_amount: 0 }, asUser(u));
    await cashSessions.markPending(s.id, { reason: 'olvido' }, asUser(u));

    const day = await businessDaysQueries.findById(s.business_day_id);
    expect(day.status).toBe('OPEN'); // sigue OPEN porque hay pendiente

    // Al reconciliar la PENDING, la jornada transita a READY_TO_CLOSE.
    const admin = await createUserFixture({ role: 'ADMIN' });
    await cashSessions.reconcile(s.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(admin));
    const dayAfter = await businessDaysQueries.findById(s.business_day_id);
    expect(dayAfter.status).toBe('READY_TO_CLOSE');
  });

  it('cierre manual de jornada: READY_TO_CLOSE → CLOSED por supervisor', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const supervisor = await createUserFixture({ role: 'ADMIN' });
    const s = await cashSessions.open({ opening_amount: 0 }, asUser(u));
    await cashSessions.close(s.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(u));

    const closed = await businessDays.close(s.business_day_id, { observations: 'OK' }, asUser(supervisor));
    expect(closed.status).toBe('CLOSED');
    expect(closed.closed_by).toBe(supervisor.id);
    expect(closed.observations).toBe('OK');
  });

  it('no se cierra una jornada OPEN', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const s = await cashSessions.open({ opening_amount: 0 }, asUser(u));
    await expect(businessDays.close(s.business_day_id, {}, asUser(u)))
      .rejects.toMatchObject({ status: 409 });
  });

  it('audit: CLOSED → AUDITED', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const auditor = await createUserFixture({ role: 'ADMIN' });
    const s = await cashSessions.open({ opening_amount: 0 }, asUser(u));
    await cashSessions.close(s.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(u));
    await businessDays.close(s.business_day_id, {}, asUser(auditor));
    const audited = await businessDays.audit(s.business_day_id, { observations: 'auditada' }, asUser(auditor));
    expect(audited.status).toBe('AUDITED');
    expect(audited.audited_by).toBe(auditor.id);
  });

  it('no se puede abrir caja en una jornada CLOSED', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    const supervisor = await createUserFixture({ role: 'ADMIN' });
    const s = await cashSessions.open({ opening_amount: 0 }, asUser(u));
    await cashSessions.close(s.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(u));
    await businessDays.close(s.business_day_id, {}, asUser(supervisor));

    // Mismo día, otro usuario: la sucursal ya tiene jornada CLOSED.
    const u2 = await createUserFixture({ role: 'ADMIN' });
    await expect(cashSessions.open({ opening_amount: 0 }, asUser(u2)))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/CLOSED/) });
  });

  // ── V4: GET active (jornada del día) ─────────────────────────────────
  describe('getActive (V4)', () => {
    it('devuelve null cuando no hay jornada activa', async () => {
      const active = await businessDays.getActive();
      expect(active).toBeNull();
    });

    it('devuelve la jornada OPEN con session_counts', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 0 }, asUser(u));

      const active = await businessDays.getActive();
      expect(active).not.toBeNull();
      expect(active.id).toBe(s.business_day_id);
      expect(active.status).toBe('OPEN');
      expect(active.session_counts).toMatchObject({
        open_count: 1, pending_count: 0, closed_count: 0, total_count: 1,
      });
    });

    it('sigue devolviendo la jornada cuando está en READY_TO_CLOSE', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 0 }, asUser(u));
      await cashSessions.close(s.id, {
        declared: [{ payment_method: 'CASH', declared_amount: 0 }],
      }, asUser(u));

      const active = await businessDays.getActive();
      expect(active).not.toBeNull();
      expect(active.status).toBe('READY_TO_CLOSE');
      expect(active.session_counts.closed_count).toBe(1);
    });

    it('devuelve null cuando la jornada está CLOSED', async () => {
      const u  = await createUserFixture({ role: 'ADMIN' });
      const sv = await createUserFixture({ role: 'ADMIN' });
      const s  = await cashSessions.open({ opening_amount: 0 }, asUser(u));
      await cashSessions.close(s.id, {
        declared: [{ payment_method: 'CASH', declared_amount: 0 }],
      }, asUser(u));
      await businessDays.close(s.business_day_id, {}, asUser(sv));

      const active = await businessDays.getActive();
      expect(active).toBeNull();
    });
  });

  // ── IMP-5: force-close para jornadas trabadas con cajas PENDING ───────
  describe('force-close (IMP-5)', () => {
    it('cierra una jornada que tiene cajas PENDING_RECONCILIATION', async () => {
      const u  = await createUserFixture({ role: 'COLLECTOR' });
      const sv = await createUserFixture({ role: 'ADMIN' });
      const s  = await cashSessions.open({ opening_amount: 0 }, asUser(u));
      await cashSessions.markPending(s.id, { reason: 'cobrador no volvió' }, asUser(u));

      // La transición automática a READY_TO_CLOSE NO dispara (hay PENDING).
      const before = await businessDaysQueries.findById(s.business_day_id);
      expect(before.status).toBe('OPEN');

      const forced = await businessDays.forceClose(s.business_day_id, {
        reason: 'cierre por planilla mensual',
      }, asUser(sv));
      expect(forced.status).toBe('CLOSED');
      expect(forced.closed_by).toBe(sv.id);
      expect(forced.observations).toMatch(/FORCE-CLOSE/);
      expect(forced.observations).toMatch(/1 PENDING/);

      // La caja PENDING NO se tocó: queda como deuda operativa.
      const sessAfter = await pool.query(`SELECT status FROM cash_sessions WHERE id = $1`, [s.id]);
      expect(sessAfter.rows[0].status).toBe('PENDING_RECONCILIATION');
    });

    it('rechaza 422 si reason no se pasa', async () => {
      const u  = await createUserFixture({ role: 'COLLECTOR' });
      const sv = await createUserFixture({ role: 'ADMIN' });
      const s  = await cashSessions.open({ opening_amount: 0 }, asUser(u));
      await cashSessions.markPending(s.id, { reason: 'x' }, asUser(u));

      await expect(businessDays.forceClose(s.business_day_id, {}, asUser(sv)))
        .rejects.toMatchObject({ status: 422 });
    });

    it('rechaza 409 si no hay cajas OPEN ni PENDING (usar close normal)', async () => {
      const u  = await createUserFixture({ role: 'ADMIN' });
      const sv = await createUserFixture({ role: 'ADMIN' });
      const s  = await cashSessions.open({ opening_amount: 0 }, asUser(u));
      await cashSessions.close(s.id, {
        declared: [{ payment_method: 'CASH', declared_amount: 0 }],
      }, asUser(u));

      await expect(businessDays.forceClose(s.business_day_id, {
        reason: 'no debería pasar',
      }, asUser(sv))).rejects.toMatchObject({ status: 409 });
    });

    it('rechaza 409 si la jornada ya está CLOSED/AUDITED', async () => {
      const u  = await createUserFixture({ role: 'ADMIN' });
      const sv = await createUserFixture({ role: 'ADMIN' });
      const s  = await cashSessions.open({ opening_amount: 0 }, asUser(u));
      await cashSessions.close(s.id, {
        declared: [{ payment_method: 'CASH', declared_amount: 0 }],
      }, asUser(u));
      await businessDays.close(s.business_day_id, {}, asUser(sv));

      await expect(businessDays.forceClose(s.business_day_id, {
        reason: 'tardío',
      }, asUser(sv))).rejects.toMatchObject({ status: 409 });
    });
  });

  it('constraint UNIQUE(business_date, branch_id) impide duplicar la jornada', async () => {
    const branch = await pool.query(`SELECT id FROM branches WHERE code='HQ'`);
    await pool.query(
      `INSERT INTO business_days (business_date, branch_id) VALUES (CURRENT_DATE, $1)`,
      [branch.rows[0].id],
    );
    await expect(
      pool.query(
        `INSERT INTO business_days (business_date, branch_id) VALUES (CURRENT_DATE, $1)`,
        [branch.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
