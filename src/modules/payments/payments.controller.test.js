// P08 — contrato HTTP de POST /payments con client_request_id:
//   · creación nueva → 201
//   · replay idempotente (misma clave) → 200 con la pre-carga existente
//   · clave reusada para otro cobro → 409 con code IDEMPOTENCY_KEY_REUSED

jest.mock('./payments.service', () => ({ create: jest.fn(), reverse: jest.fn() }));

const service = require('./payments.service');
const controller = require('./payments.controller');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('payments.controller.create — idempotencia (P08)', () => {
  const req = { body: { installment_id: 'inst-1' }, user: { id: 'u-1' } };

  beforeEach(() => jest.clearAllMocks());

  it('responde 201 cuando la pre-carga es nueva', async () => {
    service.create.mockResolvedValue({ id: 'pay-1', status: 'PENDING' });
    const res = mockRes();

    await controller.create(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].data).toEqual({ id: 'pay-1', status: 'PENDING' });
  });

  it('responde 200 con la pre-carga existente en un replay idempotente', async () => {
    const existing = { id: 'pay-1', status: 'PENDING', idempotent_replay: true };
    service.create.mockResolvedValue(existing);
    const res = mockRes();

    await controller.create(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toEqual(existing);
  });

  it('responde 409 con code IDEMPOTENCY_KEY_REUSED si la clave se reusó para otro cobro', async () => {
    service.create.mockRejectedValue({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'El client_request_id ya se usó para otro cobro.',
    });
    const res = mockRes();

    await controller.create(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0]).toMatchObject({ ok: false, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('un 409 de negocio sin code se responde como antes (sin campo code)', async () => {
    service.create.mockRejectedValue({ status: 409, message: 'Esta cuota ya fue pagada.' });
    const res = mockRes();

    await controller.create(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('code');
  });
});

// P06 — contrato HTTP de POST /payments/:id/reverse.
describe('payments.controller.reverse — reversión (P06)', () => {
  const req = {
    params: { id: 'pay-1' },
    body: { reason: 'error de carga' },
    user: { id: 'admin-1' },
  };

  beforeEach(() => jest.clearAllMocks());

  it('responde 200 con el cobro revertido y pasa id, motivo y admin al servicio', async () => {
    service.reverse.mockResolvedValue({ id: 'pay-1', status: 'APPROVED' });
    const res = mockRes();

    await controller.reverse(req, res);

    expect(service.reverse).toHaveBeenCalledWith('pay-1', 'error de carga', 'admin-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toEqual({ id: 'pay-1', status: 'APPROVED' });
  });

  it.each([
    [404, { status: 404, message: 'Cobro no encontrado.' }],
    [409, { status: 409, message: 'Este cobro ya fue revertido anteriormente.' }],
    [500, new Error('boom')],
  ])('mapea el error del servicio a %i', async (expected, err) => {
    service.reverse.mockRejectedValue(err);
    const res = mockRes();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await controller.reverse(req, res);

    expect(res.status).toHaveBeenCalledWith(expected);
    spy.mockRestore();
  });
});
