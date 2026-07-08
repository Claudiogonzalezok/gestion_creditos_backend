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

  it('no considera ningun dia de la semana como no laborable', () => {
    // Decision de negocio (2026-06): ningun dia de semana corre el vencimiento;
    // la cuota vence el dia que le toca aunque caiga domingo. Solo los feriados
    // declarados pueden correr una fecha.
    expect(isWeekend(new Date(2026, 0, 10))).toBe(false); // sabado → habil
    expect(isWeekend(new Date(2026, 0, 11))).toBe(false); // domingo → habil
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

  it('corre un feriado al próximo día no feriado (aunque sea domingo)', () => {
    // 2026-05-02 (sabado, feriado) → 2026-05-03 (domingo, NO feriado → habil)
    const holidayKeys = new Set(['2026-05-02']);
    const result = moveToNextBusinessDay(new Date(2026, 4, 2), holidayKeys);
    expect(toDateKey(result)).toBe('2026-05-03');
  });

  it('encadena feriados consecutivos hasta el primer día no feriado', () => {
    // 2026-05-04 (feriado) → 2026-05-05 (feriado) → 2026-05-06 (no feriado)
    const holidayKeys = new Set(['2026-05-04', '2026-05-05']);
    const result = moveToNextBusinessDay(new Date(2026, 4, 4), holidayKeys);
    expect(toDateKey(result)).toBe('2026-05-06');
  });

  it('ajusta en lote solo las fechas que caen en feriado', () => {
    // Sin corrimiento por fin de semana, solo feriados mueven:
    //   · 1/5 feriado → 2/5 (no feriado)
    //   · 3/5 domingo, no feriado → 3/5 (intacto)
    //   · 4/5 feriado → 5/5 (no feriado)
    const result = adjustDueDatesToBusinessDays(
      [new Date(2026, 4, 1), new Date(2026, 4, 3), new Date(2026, 4, 4)],
      new Set(['2026-05-01', '2026-05-04']),
    ).map(toDateKey);

    expect(result).toEqual(['2026-05-02', '2026-05-03', '2026-05-05']);
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
