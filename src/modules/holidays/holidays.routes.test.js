const express = require('express');
const request = require('supertest');

jest.mock('./holidays.controller', () => ({
  getAll: jest.fn((req, res) => res.status(200).json({ ok: true, data: [] })),
  getById: jest.fn((req, res) => res.status(200).json({ ok: true, data: { id: req.params.id } })),
  create: jest.fn((req, res) => res.status(201).json({ ok: true, data: req.body })),
  update: jest.fn((req, res) => res.status(200).json({ ok: true, data: req.body })),
  previewDuplicateYear: jest.fn((req, res) => res.status(200).json({ ok: true, data: req.body })),
  duplicateYear: jest.fn((req, res) => res.status(200).json({ ok: true, data: req.body })),
}));

jest.mock('../../middlewares/auth.middleware', () => ({
  authenticate: (req, res, next) => {
    req.user = { id: 'admin-1', role: 'ADMIN' };
    next();
  },
  authorize: () => (req, res, next) => next(),
}));

const controller = require('./holidays.controller');
const router = require('./holidays.routes');

describe('holidays.routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/holidays', router);
  });

  it('rechaza type inválido en GET /', async () => {
    const res = await request(app).get('/holidays?type=BAD');
    expect(res.status).toBe(400);
    expect(controller.getAll).not.toHaveBeenCalled();
  });

  it('rechaza active inválido en GET /', async () => {
    const res = await request(app).get('/holidays?active=nope');
    expect(res.status).toBe(400);
    expect(controller.getAll).not.toHaveBeenCalled();
  });

  it('acepta query válida y llega al controlador', async () => {
    const res = await request(app).get('/holidays?type=NATIONAL&active=true');
    expect(res.status).toBe(200);
    expect(controller.getAll).toHaveBeenCalled();
  });

  it('rechaza payload inválido en POST /', async () => {
    const res = await request(app).post('/holidays').send({
      date: '01-05-2026',
      name: 'A',
      type: 'INVALID',
    });

    expect(res.status).toBe(400);
    expect(controller.create).not.toHaveBeenCalled();
  });

  it('acepta payload válido en POST /', async () => {
    const res = await request(app).post('/holidays').send({
      date: '2026-05-01',
      name: 'Feriado puente',
      type: 'EXTRAORDINARY',
      affects_due_dates: true,
      active: true,
      repeats_annually: false,
      recalculateFutureInstallments: true,
    });

    expect(res.status).toBe(201);
    expect(controller.create).toHaveBeenCalled();
  });

  it('rechaza sourceYear inválido en preview de duplicación', async () => {
    const res = await request(app)
      .post('/holidays/duplicate-year/preview')
      .send({ sourceYear: 1999 });

    expect(res.status).toBe(400);
    expect(controller.previewDuplicateYear).not.toHaveBeenCalled();
  });

  it('rechaza id inválido en PUT /:id', async () => {
    const res = await request(app).put('/holidays/not-a-uuid').send({ name: 'Nuevo nombre' });
    expect(res.status).toBe(400);
    expect(controller.update).not.toHaveBeenCalled();
  });
});
