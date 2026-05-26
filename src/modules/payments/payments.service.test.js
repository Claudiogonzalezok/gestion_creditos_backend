jest.mock('../../config/db', () => ({
  query: jest.fn(),
}));

jest.mock('./payments.queries', () => ({
  lockAndGetPayment: jest.fn(),
  approve: jest.fn(),
  lockAndGetInstallment: jest.fn(),
  updateInstallment: jest.fn(),
  getPendingInstallmentsFrom: jest.fn(),
  shiftInstallmentDates: jest.fn(),
  lockAndGetCredit: jest.fn(),
  countPendingInstallments: jest.fn(),
  settleCredit: jest.fn(),
  findById: jest.fn(),
}));

jest.mock('./cash_movements.queries', () => ({
  create: jest.fn(),
}));

jest.mock('../cashRegister/cashRegister.queries', () => ({
  findByDate: jest.fn(),
}));

jest.mock('../systemConfig/systemConfig.queries', () => ({
  getValue: jest.fn().mockResolvedValue('3'),
}));

jest.mock('../../utils/transaction', () => ({
  withTransaction: jest.fn(),
}));

jest.mock('../../utils/date', () => ({
  localDate: jest.fn(() => '2026-05-01'),
}));

const queries = require('./payments.queries');
const cashMovementsQueries = require('./cash_movements.queries');
const cashRegisterQueries = require('../cashRegister/cashRegister.queries');
const { withTransaction } = require('../../utils/transaction');
const service = require('./payments.service');

describe('payments.service holiday-related behavior', () => {
  const client = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    withTransaction.mockImplementation(async (callback) => callback(client));
    cashRegisterQueries.findByDate.mockResolvedValue(null);
    queries.lockAndGetCredit.mockResolvedValue({ id: 'credit-1', status: 'ACTIVE' });
    queries.countPendingInstallments.mockResolvedValue(1);
    queries.findById.mockResolvedValue({ id: 'payment-1', status: 'APPROVED' });
  });

  it('aprueba un cobro aunque la fecha contable sea feriado, usando el due_date ya ajustado de la cuota', async () => {
    queries.lockAndGetPayment.mockResolvedValue({
      id: 'payment-1',
      installment_id: 'inst-1',
      amount_received: 1000,
      payment_method: 'CASH',
      transfer_reference: null,
      status: 'PENDING',
      amount_due: 1000,
      amount_paid: 0,
      installment_number: 1,
      due_date: '2026-05-04',
      credit_id: 'credit-1',
      payment_frequency: 'WEEKLY',
    });
    queries.lockAndGetInstallment.mockResolvedValue({ id: 'inst-1' });
    queries.updateInstallment.mockResolvedValue('PAID');
    queries.getPendingInstallmentsFrom.mockResolvedValue([]);

    await service.approve('payment-1', 'admin-1');

    expect(cashRegisterQueries.findByDate).toHaveBeenCalledWith('2026-05-01');
    expect(queries.approve).toHaveBeenCalledWith(client, 'payment-1', 'admin-1');
    expect(queries.shiftInstallmentDates).not.toHaveBeenCalled();
    expect(cashMovementsQueries.create).toHaveBeenCalled();
  });

  it('si un cobro adelanta cuotas, corre fechas restantes tomando como base el due_date ajustado', async () => {
    queries.lockAndGetPayment.mockResolvedValue({
      id: 'payment-1',
      installment_id: 'inst-1',
      amount_received: 2500,
      payment_method: 'CASH',
      transfer_reference: null,
      status: 'PENDING',
      amount_due: 1000,
      amount_paid: 0,
      installment_number: 1,
      due_date: '2026-05-04',
      credit_id: 'credit-1',
      payment_frequency: 'WEEKLY',
    });
    queries.lockAndGetInstallment.mockResolvedValue({ id: 'inst-1' });
    queries.updateInstallment.mockResolvedValue('PAID');
    queries.getPendingInstallmentsFrom.mockResolvedValue([
      { id: 'inst-2', amount_due: 1000, amount_paid: 0 },
    ]);
    queries.markInstallmentAsPrepaid = jest.fn().mockResolvedValue(undefined);

    await service.approve('payment-1', 'admin-1');

    expect(queries.shiftInstallmentDates).toHaveBeenCalledWith(
      client,
      'credit-1',
      'WEEKLY',
      '2026-05-04',
    );
  });
});
