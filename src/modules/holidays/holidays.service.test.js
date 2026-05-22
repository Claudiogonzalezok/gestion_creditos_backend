jest.mock('./holidays.queries', () => ({
  findAll: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  recalculateFutureInstallmentsByExactDate: jest.fn(),
  findActiveByYear: jest.fn(),
  findExistingDateTypeByYear: jest.fn(),
  bulkCreate: jest.fn(),
}));

jest.mock('../../utils/transaction', () => ({
  withTransaction: jest.fn(),
}));

jest.mock('../../utils/businessDay', () => ({
  toDateKey: jest.fn((value) => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }
    const date = new Date(value);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }),
  moveToNextBusinessDay: jest.fn(),
  getActiveHolidayKeysInRange: jest.fn(),
}));

const queries = require('./holidays.queries');
const { withTransaction } = require('../../utils/transaction');
const {
  moveToNextBusinessDay,
  getActiveHolidayKeysInRange,
} = require('../../utils/businessDay');
const service = require('./holidays.service');

describe('holidays.service', () => {
  const client = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    withTransaction.mockImplementation(async (callback) => callback(client));
  });

  it('crea feriado sin recálculo cuando el flag no aplica', async () => {
    queries.create.mockResolvedValue({
      id: 'h1',
      date: '2026-05-01',
      name: 'Puente',
      type: 'EXTRAORDINARY',
      affects_due_dates: true,
      active: true,
      repeats_annually: false,
    });

    const result = await service.create({
      date: '2026-05-01',
      name: 'Puente',
      type: 'EXTRAORDINARY',
      recalculateFutureInstallments: false,
    });

    expect(queries.create).toHaveBeenCalledWith(client, expect.objectContaining({
      repeats_annually: false,
    }));
    expect(result.recalculated_installments).toBe(0);
    expect(queries.recalculateFutureInstallmentsByExactDate).not.toHaveBeenCalled();
  });

  it('recalcula cuotas futuras solo para feriados extraordinarios activos que afectan vencimientos', async () => {
    queries.create.mockResolvedValue({
      id: 'h1',
      date: '2026-05-01',
      name: 'Puente',
      type: 'EXTRAORDINARY',
      affects_due_dates: true,
      active: true,
      repeats_annually: false,
    });
    getActiveHolidayKeysInRange.mockResolvedValue(new Set(['2026-05-01']));
    moveToNextBusinessDay.mockReturnValue(new Date(2026, 4, 5));
    queries.recalculateFutureInstallmentsByExactDate.mockResolvedValue([
      { id: 'i1' },
      { id: 'i2' },
    ]);

    const result = await service.create({
      date: '2026-05-01',
      name: 'Puente',
      type: 'EXTRAORDINARY',
      affects_due_dates: true,
      active: true,
      recalculateFutureInstallments: true,
    });

    expect(getActiveHolidayKeysInRange).toHaveBeenCalled();
    expect(moveToNextBusinessDay).toHaveBeenCalled();
    expect(queries.recalculateFutureInstallmentsByExactDate).toHaveBeenCalledWith(client, {
      targetDate: '2026-05-01',
      newDueDate: '2026-05-05',
    });
    expect(result.recalculated_installments).toBe(2);
  });

  it('ignora recálculo si el feriado creado no es extraordinario', async () => {
    queries.create.mockResolvedValue({
      id: 'h1',
      date: '2026-05-01',
      name: 'Día del trabajador',
      type: 'NATIONAL',
      affects_due_dates: true,
      active: true,
      repeats_annually: true,
    });

    const result = await service.create({
      date: '2026-05-01',
      name: 'Día del trabajador',
      type: 'NATIONAL',
      recalculateFutureInstallments: true,
    });

    expect(result.recalculated_installments).toBe(0);
    expect(queries.recalculateFutureInstallmentsByExactDate).not.toHaveBeenCalled();
  });

  it('lanza 404 al actualizar un feriado inexistente', async () => {
    queries.findById.mockResolvedValue(null);

    await expect(service.update('missing', {})).rejects.toEqual({
      status: 404,
      message: 'Feriado no encontrado.',
    });
  });

  it('fuerza repeats_annually=false al convertir a extraordinario', async () => {
    queries.findById.mockResolvedValue({ id: 'h1', repeats_annually: true });
    queries.update.mockResolvedValue({ id: 'h1', repeats_annually: false });

    await service.update('h1', { type: 'EXTRAORDINARY' });

    expect(queries.update).toHaveBeenCalledWith('h1', expect.objectContaining({
      repeats_annually: false,
    }));
  });

  it('mantiene repeats_annually actual cuando update no lo redefine', async () => {
    queries.findById.mockResolvedValue({ id: 'h1', repeats_annually: true });
    queries.update.mockResolvedValue({ id: 'h1', repeats_annually: true });

    await service.update('h1', { name: 'Actualizado' });

    expect(queries.update).toHaveBeenCalledWith('h1', expect.objectContaining({
      repeats_annually: true,
    }));
  });

  it('arma preview de duplicación anual con candidatos, conflictos, no recurrentes e inválidos', async () => {
    queries.findActiveByYear.mockResolvedValue([
      {
        date: new Date(2024, 0, 1),
        name: 'Año nuevo',
        type: 'NATIONAL',
        affects_due_dates: true,
        active: true,
        repeats_annually: true,
      },
      {
        date: new Date(2024, 1, 29),
        name: 'Bisiesto',
        type: 'LOCAL',
        affects_due_dates: true,
        active: true,
        repeats_annually: true,
      },
      {
        date: new Date(2024, 4, 1),
        name: 'No repetir',
        type: 'BANKING',
        affects_due_dates: true,
        active: true,
        repeats_annually: false,
      },
      {
        date: new Date(2024, 11, 25),
        name: 'Navidad',
        type: 'NATIONAL',
        affects_due_dates: true,
        active: true,
        repeats_annually: true,
      },
    ]);
    queries.findExistingDateTypeByYear.mockResolvedValue([
      { date: new Date(2025, 11, 25), type: 'NATIONAL' },
    ]);

    const result = await service.previewDuplicateYear(2024);

    expect(result.targetYear).toBe(2025);
    expect(result.toCreateCount).toBe(1);
    expect(result.invalidDatesCount).toBe(1);
    expect(result.nonRecurringCount).toBe(1);
    expect(result.conflictsCount).toBe(1);
    expect(result.toCreate[0].targetDate).toBe('2025-01-01');
  });

  it('marca conflict_on_insert cuando bulkCreate no inserta todos los candidatos', async () => {
    queries.findActiveByYear.mockResolvedValue([
      {
        date: new Date(2026, 0, 1),
        name: 'Año nuevo',
        type: 'NATIONAL',
        affects_due_dates: true,
        active: true,
        repeats_annually: true,
      },
      {
        date: new Date(2026, 4, 25),
        name: 'Mayo',
        type: 'LOCAL',
        affects_due_dates: true,
        active: true,
        repeats_annually: true,
      },
    ]);
    queries.findExistingDateTypeByYear.mockResolvedValue([]);
    queries.bulkCreate.mockResolvedValue([
      { date: new Date(2027, 0, 1), type: 'NATIONAL' },
    ]);

    const result = await service.duplicateYear(2026);

    expect(result.createdCount).toBe(1);
    expect(result.skipped.some((item) => item.reason === 'conflict_on_insert')).toBe(true);
    expect(result.conflictsCount).toBe(1);
  });
});
