// Unit tests del health check (issue #36): con la DB caída responde 503.

jest.mock('../../config/db', () => ({ query: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../../config/db');
const healthRoutes = require('./health.routes');

const originalError = console.error;
beforeAll(() => { console.error = jest.fn(); });
afterAll(() => { console.error = originalError; });

const app = express().use('/api/health', healthRoutes);

beforeEach(() => pool.query.mockReset());

describe('GET /api/health', () => {
  it('DB disponible → 200 con el cuerpo de siempre y db "up"', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, message: 'API funcionando correctamente.', db: 'up' });
    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
    expect(res.body).not.toHaveProperty('env');
  });

  it('DB caída (query falla) → 503 sin exponer el error interno', async () => {
    pool.query.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, db: 'down' });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED/);
  });

  it('DB colgada (query no responde) → 503 al vencer el timeout', async () => {
    process.env.HEALTH_DB_TIMEOUT_MS = '50';
    pool.query.mockReturnValue(new Promise(() => {}));
    const res = await request(app).get('/api/health');
    delete process.env.HEALTH_DB_TIMEOUT_MS;
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('down');
  });
});
