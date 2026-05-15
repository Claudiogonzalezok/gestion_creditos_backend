jest.mock('../../config/db', () => ({
  query: jest.fn(),
}));

const pool = require('../../config/db');
const queries = require('./holidays.queries');

describe('holidays.queries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('recalculateFutureInstallmentsByExactDate solo toca cuotas futuras pendientes sin pagos y preserva original_due_date', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    await queries.recalculateFutureInstallmentsByExactDate(client, {
      targetDate: '2026-05-01',
      newDueDate: '2026-05-04',
    });

    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toContain("SET original_due_date = COALESCE(i.original_due_date, i.due_date)");
    expect(sql).toContain("due_date = $2::date");
    expect(sql).toContain("i.status = 'PENDING'");
    expect(sql).toContain('i.due_date >= CURRENT_DATE');
    expect(sql).toContain('i.amount_paid = 0');
    expect(params).toEqual(['2026-05-01', '2026-05-04']);
  });

  it('bulkCreate usa ON CONFLICT(date, type) DO NOTHING para duplicación idempotente', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    await queries.bulkCreate(client, [
      {
        date: '2027-05-01',
        name: 'Día del trabajador',
        type: 'NATIONAL',
        affects_due_dates: true,
        active: true,
        repeats_annually: true,
      },
    ]);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (date, type) DO NOTHING');
  });
});
