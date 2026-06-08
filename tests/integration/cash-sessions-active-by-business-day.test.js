// Bloque V4-A — helpers V4 de caja activa por jornada
//
// Cubre los dos lookups nuevos introducidos en Fase V4.1:
//   · findActiveSessionByBusinessDay(businessDayId)
//   · lockActiveSessionByBusinessDay(client, businessDayId)
//
// El invariante "una OPEN por jornada" todavía NO está enforced a nivel DB
// (la migración 027 llega en Fase V4.5). Por eso estos tests crean a lo sumo
// una caja OPEN por jornada, sin probar el bloqueo de concurrencia (eso es
// V4.4 / V4.5).

const { pool, setupTestSuite }  = require('./helpers/db');
const { createUserFixture }     = require('./helpers/fixtures');
const cashSessionsQueries       = require('../../src/modules/cashSessions/cashSessions.queries');
const cashSessionsService       = require('../../src/modules/cashSessions/cashSessions.service');
const businessDaysService       = require('../../src/modules/businessDays/businessDays.service');
const { withTransaction }       = require('../../src/utils/transaction');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

describe('V4-A — findActiveSessionByBusinessDay / lockActiveSessionByBusinessDay', () => {
  it('findActiveSessionByBusinessDay devuelve la caja OPEN única de la jornada', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 1000 }, asUser(admin));

    const active = await cashSessionsQueries.findActiveSessionByBusinessDay(session.business_day_id);
    expect(active).not.toBeNull();
    expect(active.id).toBe(session.id);
    expect(active.status).toBe('OPEN');
    expect(active.opening_amount).toBe(1000);
  });

  it('findActiveSessionByBusinessDay devuelve null cuando no hay caja OPEN', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 0 }, asUser(admin));
    await cashSessionsService.close(session.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(admin));

    const active = await cashSessionsQueries.findActiveSessionByBusinessDay(session.business_day_id);
    expect(active).toBeNull();
  });

  it('findActiveSessionByBusinessDay NO devuelve cajas en PENDING_RECONCILIATION', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 0 }, asUser(admin));
    await cashSessionsService.markPending(session.id, { reason: 'olvido' }, asUser(admin));

    const active = await cashSessionsQueries.findActiveSessionByBusinessDay(session.business_day_id);
    expect(active).toBeNull();
  });

  it('findActiveSessionByBusinessDay para business_day inexistente devuelve null', async () => {
    const active = await cashSessionsQueries.findActiveSessionByBusinessDay(
      '00000000-0000-0000-0000-000000000000',
    );
    expect(active).toBeNull();
  });

  it('lockActiveSessionByBusinessDay dentro de tx devuelve la caja OPEN bajo lock', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 500 }, asUser(admin));

    await withTransaction(async (client) => {
      const locked = await cashSessionsQueries.lockActiveSessionByBusinessDay(
        client, session.business_day_id,
      );
      expect(locked).not.toBeNull();
      expect(locked.id).toBe(session.id);
    });
  });

  it('lockActiveSessionByBusinessDay devuelve null cuando no hay caja activa', async () => {
    const admin = await createUserFixture({ role: 'ADMIN' });
    const session = await cashSessionsService.open({ opening_amount: 0 }, asUser(admin));
    await cashSessionsService.close(session.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(admin));

    await withTransaction(async (client) => {
      const locked = await cashSessionsQueries.lockActiveSessionByBusinessDay(
        client, session.business_day_id,
      );
      expect(locked).toBeNull();
    });
  });

  it('encuentra correctamente cuando hay múltiples cajas cerradas en la jornada (V4 multi-turno)', async () => {
    // V4 permite varias cajas en una misma jornada, secuenciales. Probamos
    // que el lookup encuentra exactamente la última OPEN, ignorando las CLOSED.
    const admin = await createUserFixture({ role: 'ADMIN' });

    // Turno 1: abrir y cerrar
    const s1 = await cashSessionsService.open({ opening_amount: 0 }, asUser(admin));
    await cashSessionsService.close(s1.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(admin));

    // En este punto findActive debe devolver null (no hay OPEN).
    let active = await cashSessionsQueries.findActiveSessionByBusinessDay(s1.business_day_id);
    expect(active).toBeNull();

    // Turno 2: el modelo viejo todavía exige cerrar la caja del owner antes
    // de abrir otra — eso lo cumple el cierre anterior. La regla nueva
    // (V4.4/V4.5) será "una OPEN por jornada"; hoy se respeta porque solo
    // hay un admin abriendo.
    // Para emular el escenario V4 con jornada en READY_TO_CLOSE, transicionamos
    // la jornada y luego abrimos otra caja: el revert READY_TO_CLOSE → OPEN
    // se implementa en V4.4. Acá solo verificamos que el helper funciona
    // si manualmente revertimos.
    await pool.query(
      `UPDATE business_days SET status='OPEN', ready_to_close_at=NULL WHERE id=$1`,
      [s1.business_day_id],
    );
    const s2 = await cashSessionsService.open({ opening_amount: 200 }, asUser(admin));

    active = await cashSessionsQueries.findActiveSessionByBusinessDay(s1.business_day_id);
    expect(active).not.toBeNull();
    expect(active.id).toBe(s2.id);
    expect(active.opening_amount).toBe(200);
  });
});
