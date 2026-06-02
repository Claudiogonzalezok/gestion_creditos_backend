// Bloque L — Cajas (cash_sessions)
// Verifica el módulo nuevo de cajas Fase 1:
//   · Apertura: opening_amount, one_open_per_owner (constraint + service guard).
//   · Snapshot (X report): cálculo con drops activos.
//   · Cierre: declared por método, expected vs declared, difference, snapshot inmutable.
//   · PENDING_RECONCILIATION + reconcile (cierre tardío).
//   · Drops: add + reverse; reverse solo si caja OPEN.
//   · State machine integrity (no se opera sobre cajas terminales).

const { pool, setupTestSuite } = require('./helpers/db');
const { createUserFixture } = require('./helpers/fixtures');
const cashSessions = require('../../src/modules/cashSessions/cashSessions.service');
const cashSessionsQueries = require('../../src/modules/cashSessions/cashSessions.queries');

setupTestSuite();

const asUser = (user) => ({ id: user.id, role: user.role });

describe('L — Cajas (cash_sessions)', () => {
  describe('Apertura', () => {
    it('abre una caja con opening_amount y queda en OPEN', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 10000 }, asUser(u));
      expect(s.status).toBe('OPEN');
      expect(s.opening_amount).toBe(10000);
      expect(s.owner_user_id).toBe(u.id);
      expect(s.opened_by).toBe(u.id);
      expect(s.business_day).toBeDefined();
      expect(s.business_day.status).toBe('OPEN');
    });

    it('rechaza opening_amount negativo', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      await expect(cashSessions.open({ opening_amount: -1 }, asUser(u)))
        .rejects.toMatchObject({ status: 422 });
    });

    it('rechaza si el owner ya tiene una caja OPEN', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      await cashSessions.open({ opening_amount: 0 }, asUser(u));
      await expect(cashSessions.open({ opening_amount: 0 }, asUser(u)))
        .rejects.toMatchObject({ status: 409 });
    });

    it('PENDING_RECONCILIATION no bloquea abrir una nueva OPEN del mismo owner', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s1 = await cashSessions.open({ opening_amount: 0 }, asUser(u));
      await cashSessions.markPending(s1.id, { reason: 'olvido' }, asUser(u));
      const s2 = await cashSessions.open({ opening_amount: 0 }, asUser(u));
      expect(s2.status).toBe('OPEN');
      expect(s2.id).not.toBe(s1.id);
    });

    it('dos cobradores pueden tener su propia caja OPEN en paralelo', async () => {
      const u1 = await createUserFixture({ role: 'ADMIN' });
      const u2 = await createUserFixture({ role: 'ADMIN' });
      const s1 = await cashSessions.open({ opening_amount: 0 }, asUser(u1));
      const s2 = await cashSessions.open({ opening_amount: 0 }, asUser(u2));
      expect(s1.id).not.toBe(s2.id);
      expect(s1.business_day_id).toBe(s2.business_day_id); // misma jornada
    });
  });

  describe('Snapshot (X report)', () => {
    it('refleja opening + drops activos', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 50000 }, asUser(u));
      await cashSessions.addDrop(s.id, {
        amount: 10000, payment_method: 'CASH', destination: 'Tesorería',
      }, asUser(u));
      const x = await cashSessions.snapshot(s.id);
      expect(x.opening.cash).toBe(50000);
      expect(x.drops.cash).toBe(10000);
      expect(x.expected.cash).toBe(40000);
    });

    it('drops REVERSED no se descuentan', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 50000 }, asUser(u));
      const d = await cashSessions.addDrop(s.id, {
        amount: 10000, payment_method: 'CASH', destination: 'Tesorería',
      }, asUser(u));
      await cashSessions.reverseDrop(s.id, d.id, { reason: 'error de carga' }, asUser(u));
      const x = await cashSessions.snapshot(s.id);
      expect(x.drops.cash).toBe(0);
      expect(x.expected.cash).toBe(50000);
    });
  });

  describe('Cierre normal', () => {
    it('cierra con declared por método y calcula difference EXACT', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 10000 }, asUser(u));
      const closed = await cashSessions.close(s.id, {
        declared: [
          { payment_method: 'CASH',     declared_amount: 10000 },
          { payment_method: 'TRANSFER', declared_amount: 0 },
        ],
      }, asUser(u));
      expect(closed.status).toBe('CLOSED');
      expect(closed.closure_total_difference).toBe(0);
      expect(closed.closure_difference_status).toBe('EXACT');
      expect(closed.closure_snapshot.version).toBe(1);
      expect(closed.closure_details).toHaveLength(2);
      const cashDetail = closed.closure_details.find((d) => d.payment_method === 'CASH');
      expect(cashDetail.expected_amount).toBe(10000);
      expect(cashDetail.declared_amount).toBe(10000);
      expect(cashDetail.difference).toBe(0);
      expect(cashDetail.difference_status).toBe('EXACT');
    });

    it('declarado mayor → SURPLUS', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 10000 }, asUser(u));
      const closed = await cashSessions.close(s.id, {
        declared: [
          { payment_method: 'CASH',     declared_amount: 10500 },
          { payment_method: 'TRANSFER', declared_amount: 0 },
        ],
      }, asUser(u));
      expect(closed.closure_difference_status).toBe('SURPLUS');
      expect(closed.closure_total_difference).toBeCloseTo(500, 2);
    });

    it('declarado menor → SHORTAGE', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 10000 }, asUser(u));
      const closed = await cashSessions.close(s.id, {
        declared: [
          { payment_method: 'CASH',     declared_amount: 9000 },
          { payment_method: 'TRANSFER', declared_amount: 0 },
        ],
      }, asUser(u));
      expect(closed.closure_difference_status).toBe('SHORTAGE');
      expect(closed.closure_total_difference).toBeCloseTo(-1000, 2);
    });

    it('snapshot incluye drops activos en el detalle', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 10000 }, asUser(u));
      await cashSessions.addDrop(s.id, {
        amount: 3000, payment_method: 'CASH', destination: 'Banco',
      }, asUser(u));
      const closed = await cashSessions.close(s.id, {
        declared: [
          { payment_method: 'CASH',     declared_amount: 7000 },
          { payment_method: 'TRANSFER', declared_amount: 0 },
        ],
      }, asUser(u));
      expect(closed.closure_snapshot.drops.cash).toBe(3000);
      expect(closed.closure_snapshot.drops.items).toHaveLength(1);
      expect(closed.closure_snapshot.expected.cash).toBe(7000);
    });

    it('no se puede cerrar una caja ya CLOSED', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 0 }, asUser(u));
      await cashSessions.close(s.id, {
        declared: [{ payment_method: 'CASH', declared_amount: 0 }],
      }, asUser(u));
      await expect(cashSessions.close(s.id, {
        declared: [{ payment_method: 'CASH', declared_amount: 0 }],
      }, asUser(u))).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('PENDING_RECONCILIATION + reconcile', () => {
    it('marca como pendiente con motivo obligatorio', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 5000 }, asUser(u));
      const p = await cashSessions.markPending(s.id, { reason: 'cobrador no volvió' }, asUser(u));
      expect(p.status).toBe('PENDING_RECONCILIATION');
      expect(p.pending_reconciliation_reason).toBe('cobrador no volvió');
    });

    it('mark-pending sin reason falla 422', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 0 }, asUser(u));
      await expect(cashSessions.markPending(s.id, { reason: '' }, asUser(u)))
        .rejects.toMatchObject({ status: 422 });
    });

    it('reconcile sobre PENDING → CLOSED con late_reconciliation=true en snapshot', async () => {
      const owner = await createUserFixture({ role: 'ADMIN' });
      const admin = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 5000 }, asUser(owner));
      await cashSessions.markPending(s.id, { reason: 'olvido' }, asUser(owner));

      const reconciled = await cashSessions.reconcile(s.id, {
        declared: [
          { payment_method: 'CASH',     declared_amount: 5000 },
          { payment_method: 'TRANSFER', declared_amount: 0 },
        ],
      }, asUser(admin));
      expect(reconciled.status).toBe('CLOSED');
      expect(reconciled.reconciled_by).toBe(admin.id);
      expect(reconciled.closed_by).toBe(admin.id);
      expect(reconciled.closure_snapshot.late_reconciliation).toBe(true);
    });

    it('reconcile sobre OPEN falla 409', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 0 }, asUser(u));
      await expect(cashSessions.reconcile(s.id, {
        declared: [{ payment_method: 'CASH', declared_amount: 0 }],
      }, asUser(u))).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('Drops', () => {
    it('agrega y devuelve el drop', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 50000 }, asUser(u));
      const d = await cashSessions.addDrop(s.id, {
        amount: 12000, payment_method: 'CASH', destination: 'Tesorería',
        reason: 'fin de la mañana', receipt_reference: 'R-123',
      }, asUser(u));
      expect(d.amount).toBe(12000);
      expect(d.status).toBe('ACTIVE');
      expect(d.destination).toBe('Tesorería');
    });

    it('no se agregan drops a cajas CLOSED', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 0 }, asUser(u));
      await cashSessions.close(s.id, {
        declared: [{ payment_method: 'CASH', declared_amount: 0 }],
      }, asUser(u));
      await expect(cashSessions.addDrop(s.id, {
        amount: 1, payment_method: 'CASH', destination: 'X',
      }, asUser(u))).rejects.toMatchObject({ status: 409 });
    });

    it('reverse marca status=REVERSED y persiste reversed_by/reason', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 50000 }, asUser(u));
      const d = await cashSessions.addDrop(s.id, {
        amount: 5000, payment_method: 'CASH', destination: 'Tesorería',
      }, asUser(u));
      const rev = await cashSessions.reverseDrop(s.id, d.id, { reason: 'me equivoqué' }, asUser(u));
      expect(rev.status).toBe('REVERSED');
      expect(rev.reversed_by).toBe(u.id);
      expect(rev.reversed_reason).toBe('me equivoqué');
    });

    it('no se puede revertir un drop ya REVERSED', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 50000 }, asUser(u));
      const d = await cashSessions.addDrop(s.id, {
        amount: 5000, payment_method: 'CASH', destination: 'Tesorería',
      }, asUser(u));
      await cashSessions.reverseDrop(s.id, d.id, { reason: 'r' }, asUser(u));
      await expect(cashSessions.reverseDrop(s.id, d.id, { reason: 'r2' }, asUser(u)))
        .rejects.toMatchObject({ status: 409 });
    });
  });

  describe('Constraint a nivel DB: one_open_per_owner', () => {
    it('el unique index parcial bloquea dos OPEN del mismo owner aún saltándose el service', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      await cashSessions.open({ opening_amount: 0 }, asUser(u));
      // Intento insertar a mano una segunda OPEN del mismo owner:
      const businessDayRow = await pool.query(
        `SELECT id FROM business_days WHERE branch_id = (SELECT id FROM branches WHERE code='HQ') AND business_date = CURRENT_DATE`,
      );
      await expect(
        pool.query(
          `INSERT INTO cash_sessions (business_day_id, owner_user_id, opened_by, opening_amount)
           VALUES ($1, $2, $2, 0)`,
          [businessDayRow.rows[0].id, u.id],
        ),
      ).rejects.toMatchObject({ code: '23505' }); // unique_violation
    });
  });

  describe('Snapshot inmutable', () => {
    it('el closure_snapshot persiste tal cual fue grabado', async () => {
      const u = await createUserFixture({ role: 'ADMIN' });
      const s = await cashSessions.open({ opening_amount: 10000 }, asUser(u));
      await cashSessions.close(s.id, {
        declared: [
          { payment_method: 'CASH', declared_amount: 10000 },
          { payment_method: 'TRANSFER', declared_amount: 0 },
        ],
      }, asUser(u));
      const fresh = await cashSessionsQueries.findById(s.id);
      expect(fresh.closure_snapshot.version).toBe(1);
      expect(fresh.closure_snapshot.opening.cash).toBe(10000);
      expect(fresh.closure_snapshot.declared.cash).toBe(10000);
      expect(fresh.closure_snapshot.expected.cash).toBe(10000);
      expect(fresh.closure_snapshot.difference.cash).toBe(0);
      expect(typeof fresh.closure_snapshot.captured_at).toBe('string');
    });
  });
});
