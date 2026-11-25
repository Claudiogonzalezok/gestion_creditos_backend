// Unit tests de withTransaction (issue #31).
// Cliente fake: verifica que un ROLLBACK que falla no tape el error original
// y que la conexión rota se libere con error (el pool la descarta).

jest.mock('../config/db', () => ({ connect: jest.fn() }));

const pool = require('../config/db');
const { withTransaction, rollbackSafely } = require('./transaction');

const originalError = console.error;
beforeAll(() => { console.error = jest.fn(); });
afterAll(() => { console.error = originalError; });

/**
 * Crea un cliente fake cuyo query falla según el SQL recibido.
 * @param {Object<string, Error>} failures - SQL → error a lanzar.
 */
const fakeClient = (failures = {}) => ({
  query: jest.fn(async (sql) => {
    if (failures[sql]) throw failures[sql];
    return { rows: [] };
  }),
  release: jest.fn(),
});

beforeEach(() => pool.connect.mockReset());

describe('withTransaction', () => {
  it('confirma y libera sin argumento cuando el callback tiene éxito', async () => {
    const client = fakeClient();
    pool.connect.mockResolvedValue(client);

    const result = await withTransaction(async () => 'ok');

    expect(result).toBe('ok');
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'COMMIT']);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
  });

  it('hace ROLLBACK, relanza el error original y libera sin argumento si el ROLLBACK funciona', async () => {
    const client = fakeClient();
    pool.connect.mockResolvedValue(client);

    await expect(
      withTransaction(async () => { throw new Error('fallo de negocio'); }),
    ).rejects.toThrow('fallo de negocio');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledWith();
  });

  it('si el ROLLBACK falla propaga el error original y libera el cliente con el error', async () => {
    const rollbackErr = new Error('Connection terminated unexpectedly');
    const client = fakeClient({ ROLLBACK: rollbackErr });
    pool.connect.mockResolvedValue(client);

    await expect(
      withTransaction(async () => { throw new Error('duplicate key value'); }),
    ).rejects.toThrow('duplicate key value');

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]).toHaveLength(1);
    expect(client.release).toHaveBeenCalledWith(rollbackErr);
    expect(console.error).toHaveBeenCalled();
  });

  it('si falla el connect relanza el error sin intentar ROLLBACK', async () => {
    pool.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(withTransaction(async () => 'x')).rejects.toThrow('ECONNREFUSED');
  });
});

describe('rollbackSafely', () => {
  it('devuelve null cuando el ROLLBACK funciona', async () => {
    expect(await rollbackSafely(fakeClient())).toBeNull();
  });

  it('devuelve el error del ROLLBACK sin lanzarlo', async () => {
    const rbErr = new Error('rb');
    expect(await rollbackSafely(fakeClient({ ROLLBACK: rbErr }))).toBe(rbErr);
  });
});
