jest.mock('./holidays.service', () => ({
  getAll: jest.fn(),
  getById: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  previewDuplicateYear: jest.fn(),
  duplicateYear: jest.fn(),
}));

jest.mock('../../utils/response', () => ({
  success: jest.fn(),
  created: jest.fn(),
  notFound: jest.fn(),
  conflict: jest.fn(),
  serverError: jest.fn(),
}));

const service = require('./holidays.service');
const response = require('../../utils/response');
const controller = require('./holidays.controller');

describe('holidays.controller', () => {
  let req;
  let res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { query: {}, params: {}, body: {} };
    res = {};
  });

  it('parsea filtros booleanos en getAll', async () => {
    req.query = {
      type: 'NATIONAL',
      active: 'true',
      affects_due_dates: 'false',
    };
    service.getAll.mockResolvedValue([{ id: 'h1' }]);

    await controller.getAll(req, res);

    expect(service.getAll).toHaveBeenCalledWith({
      type: 'NATIONAL',
      active: true,
      affects_due_dates: false,
    });
    expect(response.success).toHaveBeenCalled();
  });

  it('mapea 404 en getById', async () => {
    req.params.id = 'missing';
    service.getById.mockRejectedValue({ status: 404, message: 'Feriado no encontrado.' });

    await controller.getById(req, res);

    expect(response.notFound).toHaveBeenCalledWith(res, 'Feriado no encontrado.');
  });

  it('mapea 23505 a conflict en create', async () => {
    req.body = { date: '2026-05-01' };
    service.create.mockRejectedValue({ code: '23505' });

    await controller.create(req, res);

    expect(response.conflict).toHaveBeenCalledWith(
      res,
      'Ya existe un feriado para esa fecha y tipo.',
    );
  });

  it('responde created en create exitoso', async () => {
    service.create.mockResolvedValue({ holiday: { id: 'h1' } });

    await controller.create(req, res);

    expect(response.created).toHaveBeenCalledWith(
      res,
      { holiday: { id: 'h1' } },
      'Feriado registrado correctamente.',
    );
  });

  it('envía previewDuplicateYear al response success', async () => {
    req.body = { sourceYear: 2026 };
    service.previewDuplicateYear.mockResolvedValue({ targetYear: 2027 });

    await controller.previewDuplicateYear(req, res);

    expect(service.previewDuplicateYear).toHaveBeenCalledWith(2026);
    expect(response.success).toHaveBeenCalledWith(
      res,
      { targetYear: 2027 },
      'Vista previa de duplicación generada.',
    );
  });

  it('delegaa duplicateYear y responde success', async () => {
    req.body = { sourceYear: 2026 };
    service.duplicateYear.mockResolvedValue({ createdCount: 2 });

    await controller.duplicateYear(req, res);

    expect(service.duplicateYear).toHaveBeenCalledWith(2026);
    expect(response.success).toHaveBeenCalledWith(
      res,
      { createdCount: 2 },
      'Duplicación anual de feriados completada.',
    );
  });

  it('deriva errores genéricos a serverError en update', async () => {
    service.update.mockRejectedValue(new Error('boom'));

    await controller.update(req, res);

    expect(response.serverError).toHaveBeenCalled();
  });
});
