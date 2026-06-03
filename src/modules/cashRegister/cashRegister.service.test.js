/**
 * Tests para cashRegister.service — Jornada Comercial (CA-02)
 *
 * CA-02 gap: close() no verifica pre-cargas pendientes cuando la jornada activa
 * es del día anterior (registerDate !== today). El chequeo `isToday && !data.force`
 * evalúa false cuando registerDate = ayer y today = hoy, permitiendo cerrar la caja
 * con cobros sin aprobar.
 *
 * Este test DEBE FALLAR con el código actual y PASAR después de la corrección.
 */

jest.mock('../../config/db', () => ({
  connect: jest.fn(),
  query: jest.fn(),
}));

jest.mock('./cashRegister.queries', () => ({
  findUnclosedJornadaDate: jest.fn(),
  findByDate:              jest.fn(),
  getPendingPaymentsToday: jest.fn(),
  getDailyTotals:          jest.fn(),
  getDashboard:            jest.fn(),
  getPreClose:             jest.fn(),
  create:                  jest.fn(),
  linkLiquidations:        jest.fn(),
  findAll:                 jest.fn(),
  findById:                jest.fn(),
}));

jest.mock('../../utils/date', () => ({
  localDate: jest.fn(),
}));

jest.mock('../businessDays/businessDays.queries', () => ({
  findDefaultBranch: jest.fn(),
  findActiveJornadaDate: jest.fn(),
}));

const queries       = require('./cashRegister.queries');
const businessDaysQueries = require('../businessDays/businessDays.queries');
const { localDate } = require('../../utils/date');
const service       = require('./cashRegister.service');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pool connect mock con transacción. */
const mockPoolClient = () => {
  const client = { query: jest.fn(), release: jest.fn() };
  require('../../config/db').connect.mockResolvedValue(client);
  client.query.mockResolvedValue({});
  return client;
};

// ── CA-02 gap: pending check se salta cuando jornada != hoy ───────────────────

describe('CA-02 — close() con jornada anterior a hoy', () => {
  const TODAY     = '2026-05-29'; // día calendario actual (pasó medianoche)
  const YESTERDAY = '2026-05-28'; // jornada comercial activa

  beforeEach(() => {
    jest.clearAllMocks();
    localDate.mockReturnValue(TODAY);

    // La jornada activa es AYER (hay actividad sin cerrar del día anterior)
    businessDaysQueries.findDefaultBranch.mockResolvedValue({ id: 'branch-hq' });
    businessDaysQueries.findActiveJornadaDate.mockResolvedValue(YESTERDAY);

    // La caja de ayer NO está cerrada todavía
    queries.findByDate.mockResolvedValue(null);

    // HAY pre-cargas pendientes de la jornada de ayer
    queries.getPendingPaymentsToday.mockResolvedValue({ count: 2, amount: 30000 });

    // Totales para poder proceder si el chequeo no bloquea
    queries.getDailyTotals.mockResolvedValue({
      cash_amount: 45000, transfer_amount: 20000,
      gross_cash: 45000, gross_transfer: 20000, total_outflows: 5000,
    });

    mockPoolClient();
  });

  it('[DEBE FALLAR] close() lanza 409 cuando hay pre-cargas pendientes de la jornada activa', async () => {
    // Con el código actual: isToday = (YESTERDAY === TODAY) = false → check se salta → no lanza
    // Con el fix: siempre verifica getPendingPaymentsToday(registerDate) → lanza 409
    await expect(
      service.close({ declared_cash: 45000 }, 'admin-001')
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/pre-carga|pendiente/i),
    });

    expect(queries.getPendingPaymentsToday).toHaveBeenCalledWith(YESTERDAY);
  });

  it('[DEBE FALLAR] close() con force:true cierra aunque haya pendientes de la jornada activa', async () => {
    // Este sí debería pasar tanto antes como después del fix
    queries.create.mockResolvedValue({
      id: 'cr-001', register_date: YESTERDAY,
      total_collected: 65000, cash_amount: 45000, transfer_amount: 20000,
      total_outflows: 5000, declared_cash: 45000, difference: 0,
      difference_status: 'EXACT', observations: null, created_at: `${YESTERDAY}T03:00:00Z`,
    });
    queries.linkLiquidations.mockResolvedValue();

    const result = await service.close({ declared_cash: 45000, force: true }, 'admin-001');
    expect(result.register_date).toBe(YESTERDAY);
  });
});

// ── getActiveJornadaDate: comportamiento base ─────────────────────────────────

describe('getActiveJornadaDate()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    businessDaysQueries.findDefaultBranch.mockResolvedValue({ id: 'branch-hq' });
  });

  it('retorna la jornada de ayer cuando hay actividad sin cerrar', async () => {
    localDate.mockReturnValue('2026-05-29');
    businessDaysQueries.findActiveJornadaDate.mockResolvedValue('2026-05-28');

    const date = await service.getActiveJornadaDate();
    expect(date).toBe('2026-05-28');
    expect(businessDaysQueries.findActiveJornadaDate).toHaveBeenCalledWith('branch-hq');
  });

  it('retorna hoy como fallback cuando no hay jornada sin cerrar', async () => {
    localDate.mockReturnValue('2026-05-29');
    businessDaysQueries.findActiveJornadaDate.mockResolvedValue(null);

    const date = await service.getActiveJornadaDate();
    expect(date).toBe('2026-05-29');
  });
});
