// Unit tests del wrapper runWithLogging.
// Mockea pool.query para verificar el contrato sin tocar la DB:
//   · Insert inicial → captura logId, ejecuta fn.
//   · Update final con resultado (number / objeto / undefined).
//   · Si fn lanza → success=false con error_message, NO re-propaga.
//   · Robustez: si el insert inicial falla, fn igual corre. Si el update
//     final falla, no rompe el flujo.

jest.mock('../config/db', () => ({
  query: jest.fn(),
}));

const pool = require('../config/db');
const { runWithLogging } = require('./cronLogger');

// Silenciamos console.error en tests para que no ensucie el output.
const originalError = console.error;
beforeAll(() => { console.error = jest.fn(); });
afterAll(()  => { console.error = originalError; });

beforeEach(() => {
  pool.query.mockReset();
});

// Mock estándar: el primer query (INSERT) devuelve id=42.
const mockInsertReturnsId = (id = 42) => {
  pool.query.mockImplementationOnce(() => Promise.resolve({ rows: [{ id }] }));
};

// Mock estándar: el segundo query (UPDATE) resuelve sin valor.
const mockUpdateOK = () => {
  pool.query.mockImplementationOnce(() => Promise.resolve({ rows: [] }));
};

describe('runWithLogging — flujo normal', () => {
  it('inserta el inicio y cierra con success=TRUE cuando fn retorna undefined', async () => {
    mockInsertReturnsId(7);
    mockUpdateOK();
    const fn = jest.fn().mockResolvedValue(undefined);

    const result = await runWithLogging('jobX', fn);

    expect(result).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);

    // Insert inicial
    expect(pool.query).toHaveBeenNthCalledWith(1,
      expect.stringContaining('INSERT INTO cron_execution_log'),
      ['jobX', expect.any(Date)],
    );

    // Update final con success=TRUE y affected_rows=null, metadata=null
    expect(pool.query).toHaveBeenNthCalledWith(2,
      expect.stringContaining('success = TRUE'),
      [null, null, 7],
    );
  });

  it('normaliza result tipo number → affected_rows = number, metadata = null', async () => {
    mockInsertReturnsId(10);
    mockUpdateOK();
    const fn = jest.fn().mockResolvedValue(15);

    const result = await runWithLogging('jobY', fn);

    expect(result).toBe(15);
    expect(pool.query).toHaveBeenNthCalledWith(2,
      expect.stringContaining('success = TRUE'),
      [15, null, 10],
    );
  });

  it('normaliza result tipo objeto { affected_rows, metadata }', async () => {
    mockInsertReturnsId(11);
    mockUpdateOK();
    const fn = jest.fn().mockResolvedValue({
      affected_rows: 3,
      metadata: { processed: 3, skipped: 1 },
    });

    const result = await runWithLogging('jobZ', fn);

    expect(result).toEqual({ affected_rows: 3, metadata: { processed: 3, skipped: 1 } });
    expect(pool.query).toHaveBeenNthCalledWith(2,
      expect.stringContaining('success = TRUE'),
      [3, JSON.stringify({ processed: 3, skipped: 1 }), 11],
    );
  });

  it('acepta también la forma camelCase affectedRows', async () => {
    mockInsertReturnsId(12);
    mockUpdateOK();
    const fn = jest.fn().mockResolvedValue({ affectedRows: 7 });

    await runWithLogging('jobCamel', fn);

    expect(pool.query).toHaveBeenNthCalledWith(2,
      expect.anything(),
      [7, null, 12],
    );
  });

  it('forwardea el valor de fn al caller', async () => {
    mockInsertReturnsId(13);
    mockUpdateOK();
    const fn = jest.fn().mockResolvedValue({ affected_rows: 1, metadata: { x: 1 } });

    const result = await runWithLogging('jobFwd', fn);

    expect(result).toEqual({ affected_rows: 1, metadata: { x: 1 } });
  });
});

describe('runWithLogging — fn lanza', () => {
  it('registra success=FALSE con error_message y NO re-propaga', async () => {
    mockInsertReturnsId(20);
    mockUpdateOK();
    const fn = jest.fn().mockRejectedValue(new Error('boom'));

    const result = await runWithLogging('jobErr', fn);

    expect(result).toBeUndefined();   // no re-propaga
    expect(pool.query).toHaveBeenNthCalledWith(2,
      expect.stringContaining('success = FALSE'),
      ['boom', 20],
    );
  });

  it('si fn lanza un string, lo registra como error_message', async () => {
    mockInsertReturnsId(21);
    mockUpdateOK();
    // eslint-disable-next-line prefer-promise-reject-errors
    const fn = jest.fn().mockRejectedValue('algo raro pasó');

    await runWithLogging('jobStrErr', fn);

    expect(pool.query).toHaveBeenNthCalledWith(2,
      expect.stringContaining('success = FALSE'),
      ['algo raro pasó', 21],
    );
  });

  it('si fn lanza error sin message, registra el String(err)', async () => {
    mockInsertReturnsId(22);
    mockUpdateOK();
    const weird = { foo: 'bar' };
    const fn = jest.fn().mockRejectedValue(weird);

    await runWithLogging('jobWeird', fn);

    expect(pool.query).toHaveBeenNthCalledWith(2,
      expect.stringContaining('success = FALSE'),
      [String(weird), 22],
    );
  });
});

describe('runWithLogging — robustez ante fallas del propio logging', () => {
  it('si el INSERT inicial falla, fn igual se ejecuta y no hay update', async () => {
    pool.query.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    const fn = jest.fn().mockResolvedValue(42);

    const result = await runWithLogging('jobNoInsert', fn);

    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
    // Solo se llamó al insert (falló). NO se llamó al update porque logId quedó null.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('si el INSERT inicial falla y fn además lanza, el error de fn se silencia igual', async () => {
    pool.query.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    const fn = jest.fn().mockRejectedValue(new Error('job crash'));

    const result = await runWithLogging('jobDoubleFail', fn);

    expect(result).toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(1);  // solo el INSERT fallido
  });

  it('si el UPDATE final falla, no rompe el flujo y retorna el valor de fn', async () => {
    mockInsertReturnsId(30);
    pool.query.mockImplementationOnce(() => Promise.reject(new Error('update fail')));
    const fn = jest.fn().mockResolvedValue(99);

    const result = await runWithLogging('jobUpdateFail', fn);

    expect(result).toBe(99);
    expect(pool.query).toHaveBeenCalledTimes(2);  // insert OK + update fallido
  });

  it('si el UPDATE final tras error también falla, no rompe nada', async () => {
    mockInsertReturnsId(31);
    pool.query.mockImplementationOnce(() => Promise.reject(new Error('update fail')));
    const fn = jest.fn().mockRejectedValue(new Error('job error'));

    const result = await runWithLogging('jobDoubleFinalFail', fn);

    expect(result).toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
