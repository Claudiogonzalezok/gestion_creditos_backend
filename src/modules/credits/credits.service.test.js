jest.mock('../../config/db', () => ({
  query: jest.fn(),
}));

jest.mock('./credits.queries', () => ({
  findById: jest.fn(),
  approve: jest.fn(),
  generateInstallments: jest.fn(),
  findCreditUnits: jest.fn(),
  saveHistoricalRate: jest.fn(),
  createDownPayment: jest.fn(),
  createCommission: jest.fn(),
}));

jest.mock('../interestRates/interestRates.queries', () => ({
  findActiveRate: jest.fn(),
}));

jest.mock('../productRates/productRates.queries', () => ({
  findActiveRate: jest.fn(),
}));

jest.mock('../productUnits/productUnits.queries', () => ({
  updateStatusBulk: jest.fn(),
}));

jest.mock('../systemConfig/systemConfig.queries', () => ({
  getValue: jest.fn(),
}));

jest.mock('../../utils/transaction', () => ({
  withTransaction: jest.fn(),
}));

jest.mock('../cashRegister/cashRegister.queries', () => ({
  findUnclosedJornadaDate: jest.fn().mockResolvedValue(null),
}));

jest.mock('../businessDays/businessDays.queries', () => ({
  findDefaultBranch: jest.fn(),
  findActiveJornadaDate: jest.fn(),
}));

jest.mock('../../utils/businessDay', () => {
  const actual = jest.requireActual('../../utils/businessDay');
  return {
    ...actual,
    getActiveHolidayKeysInRange: jest.fn(),
  };
});

const pool = require('../../config/db');
const queries = require('./credits.queries');
const irQueries = require('../interestRates/interestRates.queries');
const prQueries = require('../productRates/productRates.queries');
const puQueries = require('../productUnits/productUnits.queries');
const { getValue } = require('../systemConfig/systemConfig.queries');
const { withTransaction } = require('../../utils/transaction');
const businessDaysQueries = require('../businessDays/businessDays.queries');
const { getActiveHolidayKeysInRange } = require('../../utils/businessDay');
const service = require('./credits.service');

const toKey = (date) => {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

describe('credits.service holiday integration', () => {
  const client = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date(2026, 3, 24, 12, 0, 0, 0));
    withTransaction.mockImplementation(async (callback) => callback(client));
    getActiveHolidayKeysInRange.mockResolvedValue(new Set(['2026-05-01']));
    getValue.mockResolvedValue('0.08');
    businessDaysQueries.findDefaultBranch.mockResolvedValue({ id: 'branch-hq' });
    businessDaysQueries.findActiveJornadaDate.mockResolvedValue('2026-04-24');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('mueve al próximo día hábil una simulación LOAN cuando la primera cuota cae en feriado', async () => {
    irQueries.findActiveRate.mockResolvedValue({ rate: 0.1 });

    const result = await service.simulate({
      type: 'LOAN',
      total_amount: 100000,
      installments_count: 2,
      payment_frequency: 'WEEKLY',
      first_payment_date: '2026-05-01',
    });

    expect(getActiveHolidayKeysInRange).toHaveBeenCalled();
    // 2026-05-01 vie feriado → 2026-05-02 sabado HABIL (cliente decidio
    // sabado operativo, 2026-06). 2026-05-08 vie habil sigue igual.
    expect(result.schedule.map((row) => row.due_date)).toEqual([
      '2026-05-02',
      '2026-05-08',
    ]);
  });

  it('mueve al próximo día hábil las cuotas al aprobar un LOAN con feriado cargado', async () => {
    queries.findById
      .mockResolvedValueOnce({
        id: 'credit-loan-1',
        type: 'LOAN',
        status: 'PENDING_APPROVAL',
        payment_frequency: 'WEEKLY',
        installments_count: 2,
        total_amount: 100000,
      })
      .mockResolvedValueOnce({
        id: 'credit-loan-1',
        type: 'LOAN',
        status: 'ACTIVE',
      });
    irQueries.findActiveRate.mockResolvedValue({ rate: 0.1 });

    await service.approve('credit-loan-1', 'admin-1');

    expect(queries.generateInstallments).toHaveBeenCalled();
    const dueDates = queries.generateInstallments.mock.calls[0][3].map(toKey);
    expect(dueDates).toEqual(['2026-05-02', '2026-05-08']);
  });

  it('mueve al próximo día hábil las cuotas al aprobar una SALE con feriado cargado', async () => {
    queries.findById
      .mockResolvedValueOnce({
        id: 'credit-sale-1',
        type: 'SALE',
        status: 'PENDING_APPROVAL',
        payment_frequency: 'WEEKLY',
        installments_count: 2,
        total_amount: 100000,
        down_payment: 0,
        created_by: 'seller-1',
      })
      .mockResolvedValueOnce({
        id: 'credit-sale-1',
        type: 'SALE',
        status: 'ACTIVE',
      });
    queries.findCreditUnits.mockResolvedValue([
      {
        unit_id: 'unit-1',
        unit_status: 'RESERVED',
        historical_price: 100000,
        product_id: 'product-1',
        title: 'Producto demo',
        credit_product_id: 'cp-1',
      },
    ]);
    prQueries.findActiveRate.mockResolvedValue({ rate: 0.1 });

    await service.approve('credit-sale-1', 'admin-1');

    expect(queries.generateInstallments).toHaveBeenCalled();
    const dueDates = queries.generateInstallments.mock.calls[0][3].map(toKey);
    expect(dueDates).toEqual(['2026-05-02', '2026-05-08']);
    expect(puQueries.updateStatusBulk).toHaveBeenCalledWith(client, ['unit-1'], 'SOLD');
  });

  it('mueve al próximo día hábil el cronograma de una simulación SALE', async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 'variant-1',
          current_price: 100000,
          variant_status: 'ACTIVE',
          color: 'Negro',
          size: null,
          capacity: '128GB',
          product_id: 'product-1',
          title: 'Producto demo',
          product_status: 'ACTIVE',
        },
      ],
    });
    prQueries.findActiveRate.mockResolvedValue({ rate: 0.1 });

    const result = await service.simulate({
      type: 'SALE',
      products: [{ variant_id: 'variant-1', quantity: 1, installments_count: 2 }],
      installments_count: 2,
      payment_frequency: 'WEEKLY',
      first_payment_date: '2026-05-01',
      down_payment: 0,
    });

    expect(result.schedule.map((row) => row.due_date)).toEqual([
      '2026-05-02',
      '2026-05-08',
    ]);
  });
});
