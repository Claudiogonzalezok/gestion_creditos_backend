jest.mock('./systemConfig.queries', () => ({ getValue: jest.fn() }));

const { getValue } = require('./systemConfig.queries');
const { getGraceDays } = require('./graceDays');

describe('getGraceDays', () => {
  beforeEach(() => getValue.mockReset());

  it('lee penalty_grace_days de system_config y lo devuelve como entero', async () => {
    getValue.mockResolvedValue('5');
    await expect(getGraceDays()).resolves.toBe(5);
    expect(getValue).toHaveBeenCalledWith('penalty_grace_days');
  });

  it('usa 3 días por defecto si la clave no está configurada', async () => {
    getValue.mockResolvedValue(null);
    await expect(getGraceDays()).resolves.toBe(3);
  });

  it('respeta 0 configurado como string', async () => {
    getValue.mockResolvedValue('0');
    await expect(getGraceDays()).resolves.toBe(0);
  });
});
