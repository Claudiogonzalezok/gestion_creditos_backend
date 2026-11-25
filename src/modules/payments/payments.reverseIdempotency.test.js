// P06 + P08 — tests unitarios (DB mockeada) de:
//   · reverse: reversión de un cobro con cuotas adelantadas, restauración de
//     vencimientos desde `advance_due_dates_snapshot` (migración 048) y guardas.
//   · create: pre-carga idempotente por `client_request_id` (replay, 409
//     IDEMPOTENCY_KEY_REUSED, fallback por índice UNIQUE) y lock cuota → crédito.

jest.mock('../../config/db', () => ({ query: jest.fn() }));

jest.mock('./payments.queries', () => ({
  lockAndGetPayment: jest.fn(),
  lockAndGetInstallment: jest.fn(),
  lockAndGetCredit: jest.fn(),
  findChildPayments: jest.fn(),
  createReversal: jest.fn(),
  restoreInstallmentFromReversal: jest.fn(),
  restoreAdvanceDueDates: jest.fn(),
  findByClientRequestId: jest.fn(),
  getPendingCommittedAmount: jest.fn(),
  getTotalPendingBalance: jest.fn(),
  create: jest.fn(),
  findById: jest.fn(),
}));

jest.mock('./cash_movements.queries', () => ({
  create: jest.fn(),
  findPaymentMovement: jest.fn(),
}));

jest.mock('../businessDays/businessDays.service', () => ({
  getActiveJornadaDate: jest.fn().mockResolvedValue('2026-11-25'),
}));

jest.mock('../businessDays/businessDays.queries', () => ({
  findDefaultBranch: jest.fn().mockResolvedValue(null),
  isJornadaMutable: jest.fn(),
}));

jest.mock('../cashSessions/cashSessions.queries', () => ({
  lockActiveSessionForCurrentJornada: jest.fn(),
}));

jest.mock('../collections/collections.queries', () => ({
  updateManagementStatusForActiveTodaySheet: jest.fn(),
}));

jest.mock('../collectionAttempts/collectionAttempts.queries', () => ({
  voidScheduledVisitsForInstallment: jest.fn(),
}));

jest.mock('../systemConfig/systemConfig.queries', () => ({
  getValue: jest.fn().mockResolvedValue('3'),
}));

jest.mock('../notifications/notifications.service', () => ({ notify: jest.fn() }));
jest.mock('../notifications/notifications.queries', () => ({
  getActiveAdminUserIds: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../utils/transaction', () => ({ withTransaction: jest.fn() }));

const queries = require('./payments.queries');
const cashMovementsQueries = require('./cash_movements.queries');
const cashSessionsQueries = require('../cashSessions/cashSessions.queries');
const collectionsQueries = require('../collections/collections.queries');
const notificationsService = require('../notifications/notifications.service');
const { withTransaction } = require('../../utils/transaction');
const service = require('./payments.service');

const KEY = '7f1c2e9a-3b4d-4c5e-8f6a-1b2c3d4e5f60';

// ─────────────────────────────────────────────────────────────────────────────
describe('payments.service.reverse — cobro con cuotas adelantadas (P06)', () => {
  let client;

  /** Cobro cabecera de 3000 que adelantó dos cuotas (hijos de 1000 c/u). */
  const header = (overrides = {}) => ({
    id: 'pay-1',
    status: 'APPROVED',
    is_reversal: false,
    parent_payment_id: null,
    reversal_payment_id: null,
    installment_id: 'inst-1',
    credit_id: 'credit-1',
    collector_id: 'col-1',
    amount_received: '3000',
    amount_cash: '3000',
    amount_transfer: '0',
    payment_method: 'CASH',
    transfer_reference: null,
    advance_due_dates_snapshot: [
      { id: 'inst-2', due_date: '2026-12-01', original_due_date: null },
      { id: 'inst-3', due_date: '2026-12-08', original_due_date: null },
    ],
    ...overrides,
  });

  const children = [
    {
      id: 'pay-2',
      installment_id: 'inst-2',
      amount_received: '1000',
      amount_cash: '1000',
      amount_transfer: '0',
      payment_method: 'CASH',
      transfer_reference: null,
    },
    {
      id: 'pay-3',
      installment_id: 'inst-3',
      amount_received: '1000',
      amount_cash: '1000',
      amount_transfer: '0',
      payment_method: 'CASH',
      transfer_reference: null,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    client = { query: jest.fn() };
    withTransaction.mockImplementation(async (cb) => cb(client));
    cashSessionsQueries.lockActiveSessionForCurrentJornada.mockResolvedValue({ id: 'sess-1' });
    queries.lockAndGetPayment.mockResolvedValue(header());
    cashMovementsQueries.findPaymentMovement.mockResolvedValue({ register_date: '2026-11-25' });
    queries.findChildPayments.mockResolvedValue(children);
    queries.createReversal.mockImplementation(async (_c, p) => ({
      id: `rev-${p.originalPaymentId}`,
    }));
    queries.lockAndGetCredit.mockResolvedValue({ id: 'credit-1', status: 'ACTIVE' });
    queries.findById.mockResolvedValue({ id: 'pay-1', status: 'APPROVED' });
  });

  it('restaura cuota cabecera solo con su parte, hijos con su monto y las fechas del snapshot', async () => {
    const result = await service.reverse('pay-1', 'error de carga', 'admin-1');

    expect(result).toEqual({ id: 'pay-1', status: 'APPROVED' });
    // Cabecera: 3000 - 2000 de hijos = 1000 imputados a ella.
    expect(queries.restoreInstallmentFromReversal).toHaveBeenCalledWith(client, 'inst-1', 1000, 3);
    expect(queries.restoreInstallmentFromReversal).toHaveBeenCalledWith(
      client,
      'inst-2',
      '1000',
      3,
    );
    expect(queries.restoreInstallmentFromReversal).toHaveBeenCalledWith(
      client,
      'inst-3',
      '1000',
      3,
    );
    // Vencimientos corridos por el adelanto vuelven a su valor previo.
    expect(queries.restoreAdvanceDueDates).toHaveBeenCalledWith(
      client,
      header().advance_due_dates_snapshot,
      3,
    );
  });

  it('solo la reversión de la cabecera impacta caja (activa); los hijos quedan sin caja', async () => {
    await service.reverse('pay-1', 'motivo', 'admin-1');

    expect(queries.createReversal).toHaveBeenCalledTimes(3);
    expect(queries.createReversal.mock.calls[0][1]).toMatchObject({
      originalPaymentId: 'pay-1',
      cashSessionId: 'sess-1',
      amountReceived: '3000',
    });
    expect(queries.createReversal.mock.calls[1][1]).toMatchObject({
      originalPaymentId: 'pay-2',
      cashSessionId: null,
    });
    expect(queries.createReversal.mock.calls[2][1]).toMatchObject({
      originalPaymentId: 'pay-3',
      cashSessionId: null,
    });
    // Un único movimiento de caja REVERSAL por el total de la cabecera.
    expect(cashMovementsQueries.create).toHaveBeenCalledTimes(1);
    expect(cashMovementsQueries.create).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        paymentId: 'rev-pay-1',
        amount: 3000,
        movementType: 'REVERSAL',
        paymentMethod: 'CASH',
      }),
    );
    expect(collectionsQueries.updateManagementStatusForActiveTodaySheet).toHaveBeenCalledWith(
      'col-1',
      'inst-1',
      'VISITED',
      client,
    );
  });

  it('cobro histórico sin snapshot no restaura fechas', async () => {
    queries.lockAndGetPayment.mockResolvedValue(header({ advance_due_dates_snapshot: null }));
    await service.reverse('pay-1', 'motivo', 'admin-1');
    expect(queries.restoreAdvanceDueDates).not.toHaveBeenCalled();
  });

  it('snapshot vacío no restaura fechas', async () => {
    queries.lockAndGetPayment.mockResolvedValue(header({ advance_due_dates_snapshot: [] }));
    await service.reverse('pay-1', 'motivo', 'admin-1');
    expect(queries.restoreAdvanceDueDates).not.toHaveBeenCalled();
  });

  it('reabre el crédito si estaba SETTLED', async () => {
    queries.lockAndGetCredit.mockResolvedValue({ id: 'credit-1', status: 'SETTLED' });
    await service.reverse('pay-1', 'motivo', 'admin-1');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'ACTIVE'"), [
      'credit-1',
    ]);
  });

  it('no reabre un crédito ACTIVE', async () => {
    await service.reverse('pay-1', 'motivo', 'admin-1');
    expect(client.query).not.toHaveBeenCalled();
  });

  it.each([
    [
      'sin caja activa',
      () => cashSessionsQueries.lockActiveSessionForCurrentJornada.mockResolvedValue(null),
      { status: 409, code: 'NO_ACTIVE_SESSION' },
    ],
    ['cobro inexistente', () => queries.lockAndGetPayment.mockResolvedValue(null), { status: 404 }],
    [
      'cobro no aprobado',
      () => queries.lockAndGetPayment.mockResolvedValue(header({ status: 'PENDING' })),
      { status: 409 },
    ],
    [
      'cobro que ya es reversión',
      () => queries.lockAndGetPayment.mockResolvedValue(header({ is_reversal: true })),
      { status: 409 },
    ],
    [
      'sub-pago por distribución',
      () => queries.lockAndGetPayment.mockResolvedValue(header({ parent_payment_id: 'pay-0' })),
      { status: 409 },
    ],
    [
      'ya revertido',
      () => queries.lockAndGetPayment.mockResolvedValue(header({ reversal_payment_id: 'rev-x' })),
      { status: 409 },
    ],
    [
      'sin movimiento de caja',
      () => cashMovementsQueries.findPaymentMovement.mockResolvedValue(null),
      { status: 409 },
    ],
  ])('rechaza: %s y no crea reversiones', async (_name, arrange, expected) => {
    arrange();
    await expect(service.reverse('pay-1', 'motivo', 'admin-1')).rejects.toMatchObject(expected);
    expect(queries.createReversal).not.toHaveBeenCalled();
    expect(queries.restoreAdvanceDueDates).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('payments.service.create — pre-carga idempotente (P08)', () => {
  const USER = { id: 'col-1', role: 'COLLECTOR' };
  let client;

  const body = (extra = {}) => ({
    installment_id: 'inst-1',
    amount_received: 1000,
    payment_method: 'CASH',
    client_request_id: KEY,
    ...extra,
  });

  const existing = (overrides = {}) => ({
    id: 'pay-1',
    installment_id: 'INST-1',
    generation_type: 'COLLECTION',
    amount_received: '1000.00',
    status: 'PENDING',
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    client = { query: jest.fn() };
    withTransaction.mockImplementation(async (cb) => cb(client));
    queries.lockAndGetInstallment.mockResolvedValue({
      id: 'inst-1',
      credit_id: 'credit-1',
      status: 'PENDING',
      amount_due: 1000,
      amount_paid: 0,
    });
    queries.lockAndGetCredit.mockResolvedValue({ id: 'credit-1', status: 'ACTIVE' });
    queries.findByClientRequestId.mockResolvedValue(null);
    queries.getPendingCommittedAmount.mockResolvedValue(0);
    queries.getTotalPendingBalance.mockResolvedValue(5000);
    queries.create.mockResolvedValue({
      id: 'pay-new',
      installment_id: 'inst-1',
      amount_received: 1000,
      status: 'PENDING',
    });
  });

  it('crea la pre-carga bloqueando cuota y luego crédito, guardando la clave', async () => {
    const result = await service.create(body(), USER);

    expect(result).toMatchObject({ id: 'pay-new', status: 'PENDING' });
    expect(result.idempotent_replay).toBeUndefined();
    expect(queries.lockAndGetInstallment).toHaveBeenCalledWith(client, 'inst-1');
    expect(queries.lockAndGetCredit).toHaveBeenCalledWith(client, 'credit-1');
    expect(queries.lockAndGetInstallment.mock.invocationCallOrder[0]).toBeLessThan(
      queries.lockAndGetCredit.mock.invocationCallOrder[0],
    );
    expect(queries.findByClientRequestId).toHaveBeenCalledWith('col-1', KEY, client);
    expect(queries.create).toHaveBeenCalledWith(
      expect.objectContaining({
        client_request_id: KEY,
        collector_id: 'col-1',
        cash_session_id: null,
      }),
      client,
    );
    expect(notificationsService.notify).toHaveBeenCalled();
    expect(collectionsQueries.updateManagementStatusForActiveTodaySheet).toHaveBeenCalledWith(
      'col-1',
      'inst-1',
      'VISITED',
    );
  });

  it('sin clave no consulta idempotencia', async () => {
    await service.create(body({ client_request_id: undefined }), USER);
    expect(queries.findByClientRequestId).not.toHaveBeenCalled();
    expect(queries.create).toHaveBeenCalled();
  });

  it('replay con la misma clave y mismo cobro devuelve la existente sin side-effects', async () => {
    queries.findByClientRequestId.mockResolvedValue(existing());

    const result = await service.create(body(), USER);

    expect(result).toMatchObject({ id: 'pay-1', idempotent_replay: true });
    expect(queries.create).not.toHaveBeenCalled();
    expect(notificationsService.notify).not.toHaveBeenCalled();
    expect(collectionsQueries.updateManagementStatusForActiveTodaySheet).not.toHaveBeenCalled();
  });

  it.each([
    ['otra cuota', existing({ installment_id: 'inst-9' })],
    ['otro monto', existing({ amount_received: '500' })],
    ['otro tipo de generación', existing({ generation_type: 'RENEWAL' })],
  ])('clave reusada para %s → 409 IDEMPOTENCY_KEY_REUSED sin crear', async (_n, prior) => {
    queries.findByClientRequestId.mockResolvedValue(prior);
    await expect(service.create(body(), USER)).rejects.toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(queries.create).not.toHaveBeenCalled();
  });

  it('choque con el índice UNIQUE se resuelve como replay leyendo fuera de la tx', async () => {
    queries.create.mockRejectedValue({
      code: '23505',
      constraint: 'ux_payments_collector_client_request',
    });
    queries.findByClientRequestId
      .mockResolvedValueOnce(null) // bajo lock: la otra tx no confirmó aún
      .mockResolvedValueOnce(existing()); // tras el choque: ya confirmó

    const result = await service.create(body(), USER);

    expect(result).toMatchObject({ id: 'pay-1', idempotent_replay: true });
    expect(queries.findByClientRequestId).toHaveBeenLastCalledWith('col-1', KEY);
  });

  it('choque con el índice UNIQUE por otro cobro → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    queries.create.mockRejectedValue({
      code: '23505',
      constraint: 'ux_payments_collector_client_request',
    });
    queries.findByClientRequestId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing({ installment_id: 'inst-2' }));

    await expect(service.create(body(), USER)).rejects.toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('otro error único (u otra constraint) se propaga sin reintentar', async () => {
    const err = { code: '23505', constraint: 'otra_constraint' };
    queries.create.mockRejectedValue(err);
    await expect(service.create(body(), USER)).rejects.toBe(err);
    expect(queries.findByClientRequestId).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'cuota inexistente',
      () => queries.lockAndGetInstallment.mockResolvedValue(null),
      {},
      { status: 404 },
    ],
    [
      'cuota pagada',
      () =>
        queries.lockAndGetInstallment.mockResolvedValue({
          id: 'inst-1',
          credit_id: 'credit-1',
          status: 'PAID',
        }),
      {},
      { status: 409 },
    ],
    [
      'crédito no activo',
      () => queries.lockAndGetCredit.mockResolvedValue({ id: 'credit-1', status: 'SETTLED' }),
      {},
      { status: 409 },
    ],
    [
      'saldo ya comprometido',
      () => queries.getPendingCommittedAmount.mockResolvedValue(1000),
      {},
      { status: 409 },
    ],
    ['parcial sin próxima visita', () => {}, { amount_received: 500 }, { status: 422 }],
    [
      'monto mayor al saldo del crédito',
      () => queries.getTotalPendingBalance.mockResolvedValue(1500),
      { amount_received: 2000 },
      { status: 422 },
    ],
  ])('rechaza: %s', async (_n, arrange, extra, expected) => {
    arrange();
    await expect(service.create(body(extra), USER)).rejects.toMatchObject(expected);
    expect(queries.create).not.toHaveBeenCalled();
  });

  it('monto que adelanta cuotas dentro del saldo del crédito se acepta', async () => {
    await service.create(body({ amount_received: 3000 }), USER);
    expect(queries.getTotalPendingBalance).toHaveBeenCalledWith('credit-1', client);
    expect(queries.create).toHaveBeenCalled();
  });
});
