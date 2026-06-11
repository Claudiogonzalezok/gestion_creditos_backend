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

  it('detecta solo el domingo como dia de la semana no laborable', () => {
    // Decision de negocio (2026-06): sabado opera con normalidad, solo
    // domingo se considera no laborable a efectos de correr vencimientos.
    expect(isWeekend(new Date(2026, 0, 10))).toBe(false); // sabado → habil
    expect(isWeekend(new Date(2026, 0, 11))).toBe(true);  // domingo → no habil
    expect(isWeekend(new Date(2026, 0, 12))).toBe(false); // lunes  → habil
  });

  it('detecta día no hábil por feriado activo', () => {
    const holidayKeys = new Set(['2026-05-01']);
    expect(isBusinessDay(new Date(2026, 4, 1), holidayKeys)).toBe(false);
  });

  it('deja intacta una fecha que ya es hábil', () => {
    const result = moveToNextBusinessDay(new Date(2026, 4, 5), new Set());
    expect(toDateKey(result)).toBe('2026-05-05');
  });

  it('salta domingo y feriados encadenados hasta el próximo día hábil', () => {
    // 2026-05-01 (vie, feriado) → 2026-05-02 sabado HABIL ahora → 2026-05-02
    const holidayKeys = new Set(['2026-05-01']);
    const result = moveToNextBusinessDay(new Date(2026, 4, 1), holidayKeys);
    expect(toDateKey(result)).toBe('2026-05-02');
  });

  it('salta domingo + feriado del lunes al martes habil', () => {
    // 2026-05-03 (dom, no habil) → 2026-05-04 (lun, feriado) → 2026-05-05 (mar)
    const holidayKeys = new Set(['2026-05-04']);
    const result = moveToNextBusinessDay(new Date(2026, 4, 3), holidayKeys);
    expect(toDateKey(result)).toBe('2026-05-05');
  });

  it('ajusta en lote varias fechas al próximo día hábil', () => {
    // Con sabado habil:
    //   · 1/5 vie feriado    → 2/5 sabado habil
    //   · 2/5 sabado          → 2/5 sigue habil
    //   · 5/5 mar             → 5/5 sigue habil
    const result = adjustDueDatesToBusinessDays(
      [new Date(2026, 4, 1), new Date(2026, 4, 2), new Date(2026, 4, 5)],
      new Set(['2026-05-01', '2026-05-04']),
    ).map(toDateKey);

    expect(result).toEqual(['2026-05-02', '2026-05-02', '2026-05-05']);
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
