// Unit tests del manejo de errores del controller de créditos (issue #33).
// Un error inesperado del service debe responder 500 con el formato estándar
// (sin colgar la request ni exponer el mensaje interno); el 404 no cambia.

jest.mock('./credits.service', () => ({ getById: jest.fn() }));
jest.mock('../payments/payments.service', () => ({}));
jest.mock('../interestRates/interestRates.queries', () => ({}));
jest.mock('../productRates/productRates.queries', () => ({}));

const service = require('./credits.service');
const controller = require('./credits.controller');

const originalError = console.error;
beforeAll(() => { console.error = jest.fn(); });
afterAll(() => { console.error = originalError; });

const mockRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('credits.controller.getById', () => {
  it('error genérico del service → 500 con formato estándar sin mensaje interno', async () => {
    service.getById.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    const res = mockRes();

    await controller.getById({ params: { id: 'x' }, user: { role: 'ADMIN' } }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.ok).toBe(false);
    expect(typeof body.message).toBe('string');
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|stack/);
  });

  it('error 404 del service → 404 con el mensaje del service (sin cambios)', async () => {
    service.getById.mockRejectedValue({ status: 404, message: 'Crédito no encontrado.' });
    const res = mockRes();

    await controller.getById({ params: { id: 'x' }, user: { role: 'ADMIN' } }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ ok: false, message: 'Crédito no encontrado.' });
  });
});
