jest.mock('../config/db', () => ({
  query: jest.fn(),
}));

const pool = require('../config/db');
const {
  toDateKey,
  isWeekend,
  isBusinessDay,
  moveToNextBusinessDay,
  adjustDueDatesToBusinessDays,
  getActiveHolidayKeysInRange,
} = require('./businessDay');

describe('businessDay utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('convierte fechas a clave local YYYY-MM-DD', () => {
    expect(toDateKey(new Date(2026, 0, 5, 10, 30))).toBe('2026-01-05');
  });

  it('detecta sábados y domingos como fin de semana', () => {
    expect(isWeekend(new Date(2026, 0, 10))).toBe(true);
    expect(isWeekend(new Date(2026, 0, 11))).toBe(true);
    expect(isWeekend(new Date(2026, 0, 12))).toBe(false);
  });

  it('detecta día no hábil por feriado activo', () => {
    const holidayKeys = new Set(['2026-05-01']);
    expect(isBusinessDay(new Date(2026, 4, 1), holidayKeys)).toBe(false);
  });

  it('deja intacta una fecha que ya es hábil', () => {
    const result = moveToNextBusinessDay(new Date(2026, 4, 5), new Set());
    expect(toDateKey(result)).toBe('2026-05-05');
  });

  it('salta fines de semana y feriados encadenados hasta el próximo día hábil', () => {
    const holidayKeys = new Set(['2026-05-01', '2026-05-04']);
    const result = moveToNextBusinessDay(new Date(2026, 4, 1), holidayKeys);
    expect(toDateKey(result)).toBe('2026-05-05');
  });

  it('ajusta en lote varias fechas al próximo día hábil', () => {
    const result = adjustDueDatesToBusinessDays(
      [new Date(2026, 4, 1), new Date(2026, 4, 2), new Date(2026, 4, 5)],
      new Set(['2026-05-01', '2026-05-04']),
    ).map(toDateKey);

    expect(result).toEqual(['2026-05-05', '2026-05-05', '2026-05-05']);
  });

  it('consulta feriados activos del rango y devuelve claves normalizadas', async () => {
    pool.query.mockResolvedValue({
      rows: [{ date: new Date(2026, 4, 1) }, { date: new Date(2026, 4, 25) }],
    });

    const result = await getActiveHolidayKeysInRange(
      new Date(2026, 4, 1),
      new Date(2026, 4, 31),
    );

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM holidays'),
      ['2026-05-01', '2026-05-31'],
    );
    expect(Array.from(result)).toEqual(['2026-05-01', '2026-05-25']);
  });
});
