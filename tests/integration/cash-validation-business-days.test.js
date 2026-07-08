// Bloque U — IMP-1: la autoridad para validar "caja del día abierta" pasó de
// cash_registers a business_days.
//
// Verifica que:
//   · getActiveJornadaDate consulta business_days y devuelve la jornada activa
//     más reciente (OPEN o READY_TO_CLOSE).
//   · _validateCajaOpen bloquea cuando la jornada está CLOSED/AUDITED.
//   · _validateCajaOpen NO bloquea cuando solo existe un cash_register legacy
//     cerrado (legacy ya no es autoridad).

const { pool, setupTestSuite } = require('./helpers/db');
const { createUserFixture }    = require('./helpers/fixtures');
const businessDaysQueries      = require('../../src/modules/businessDays/businessDays.queries');
const cashSessionsService      = require('../../src/modules/cashSessions/cashSessions.service');
const businessDaysService      = require('../../src/modules/businessDays/businessDays.service');
const paymentsService          = require('../../src/modules/payments/payments.service');
const { localDate }            = require('../../src/utils/date');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });
const today  = () => localDate();

describe('U — IMP-1: autoridad business_days reemplaza cash_registers', () => {
  it('findActiveJornadaDate devuelve la fecha de hoy si la jornada está OPEN', async () => {
    const u = await createUserFixture({ role: 'ADMIN' });
    await cashSessionsService.open({ opening_amount: 0 }, asUser(u));

    const branch = (await pool.query(`SELECT id FROM branches WHERE code='HQ'`)).rows[0];
    const date = await businessDaysQueries.findActiveJornadaDate(branch.id);
    expect(date).toBe(today());
  });

  it('findActiveJornadaDate devuelve null si todas las jornadas están CLOSED', async () => {
    const u  = await createUserFixture({ role: 'ADMIN' });
    const sv = await createUserFixture({ role: 'ADMIN' });
    const s  = await cashSessionsService.open({ opening_amount: 0 }, asUser(u));
    await cashSessionsService.close(s.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(u));
    await businessDaysService.close(s.business_day_id, {}, asUser(sv));

    const branch = (await pool.query(`SELECT id FROM branches WHERE code='HQ'`)).rows[0];
    const date = await businessDaysQueries.findActiveJornadaDate(branch.id);
    expect(date).toBeNull();
  });

  it('isJornadaMutable: OPEN → true, CLOSED → false, no existe → false', async () => {
    const u  = await createUserFixture({ role: 'ADMIN' });
    const sv = await createUserFixture({ role: 'ADMIN' });
    const branch = (await pool.query(`SELECT id FROM branches WHERE code='HQ'`)).rows[0];

    // No existe
    expect(await businessDaysQueries.isJornadaMutable('1999-01-01', branch.id)).toBe(false);

    // OPEN
    const s = await cashSessionsService.open({ opening_amount: 0 }, asUser(u));
    expect(await businessDaysQueries.isJornadaMutable(today(), branch.id)).toBe(true);

    // READY_TO_CLOSE (transición automática)
    await cashSessionsService.close(s.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(u));
    expect(await businessDaysQueries.isJornadaMutable(today(), branch.id)).toBe(true);

    // CLOSED
    await businessDaysService.close(s.business_day_id, {}, asUser(sv));
    expect(await businessDaysQueries.isJornadaMutable(today(), branch.id)).toBe(false);
  });

  it('_validateCajaOpen bloquea cuando la jornada está CLOSED', async () => {
    const u  = await createUserFixture({ role: 'ADMIN' });
    const sv = await createUserFixture({ role: 'ADMIN' });
    const s  = await cashSessionsService.open({ opening_amount: 0 }, asUser(u));
    await cashSessionsService.close(s.id, {
      declared: [{ payment_method: 'CASH', declared_amount: 0 }],
    }, asUser(u));
    await businessDaysService.close(s.business_day_id, {}, asUser(sv));

    await expect(paymentsService._validateCajaOpen(today()))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/CLOSED/) });
  });

  it('_validateCajaOpen NO bloquea cuando solo existe cash_register legacy cerrado', async () => {
    // Simulamos un cash_register cerrado para la fecha (legacy puro, sin jornada moderna).
    const branch = (await pool.query(`SELECT id FROM branches WHERE code='HQ'`)).rows[0];
    const admin  = await createUserFixture({ role: 'ADMIN' });

    // Crear cash_register legacy (mediante INSERT directo — el path de service requiere mucho setup)
    await pool.query(
      `INSERT INTO cash_registers (register_date, cash_amount, transfer_amount, total_collected,
                                   total_outflows, declared_cash, difference, difference_status, closed_by)
       VALUES ($1, 0, 0, 0, 0, 0, 0, 'EXACT', $2)`,
      [today(), admin.id],
    );

    // Sin jornada moderna en CLOSED → la validación nueva NO bloquea.
    await expect(paymentsService._validateCajaOpen(today())).resolves.toBeUndefined();
  });
});
