// Unit tests del cierre ordenado del proceso (issue #36):
// SIGTERM espera a que terminen las requests en curso antes de cerrar el pool
// y salir; los errores no manejados del proceso se loguean y salen con código 1.

const http = require('http');
const express = require('express');
const { createShutdown, registerProcessHandlers } = require('./lifecycle');

const originalError = console.error;
const originalWarn = console.warn;
beforeAll(() => { console.error = jest.fn(); console.warn = jest.fn(); });
afterAll(() => { console.error = originalError; console.warn = originalWarn; });

/** Levanta una app con una ruta lenta; devuelve el server ya escuchando. */
const listenSlowApp = (delayMs, onFinish = () => {}) =>
  new Promise((resolve) => {
    const app = express();
    app.get('/slow', (req, res) => {
      res.on('finish', onFinish);
      setTimeout(() => res.json({ done: true }), delayMs);
    });
    const server = app.listen(0, () => resolve(server));
  });

const get = (port, path) =>
  new Promise((resolve, reject) => {
    http.get({ port, path, agent: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });

describe('createShutdown', () => {
  it('no corta una request en curso: responde y recién después cierra pool, cron y sale con 0', async () => {
    const order = [];
    const server = await listenSlowApp(150, () => order.push('response'));
    const pool = { end: jest.fn(async () => { order.push('pool.end'); }) };
    const stopJobs = jest.fn(() => order.push('stopJobs'));
    const exit = jest.fn((code) => order.push(`exit:${code}`));
    const shutdown = createShutdown({ server, pool, stopJobs, exit, timeoutMs: 5000 });

    const pending = get(server.address().port, '/slow');
    await new Promise((r) => setTimeout(r, 30)); // la request ya está en curso
    await shutdown('SIGTERM');
    const res = await pending;

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ done: true });
    expect(order).toEqual(['stopJobs', 'response', 'pool.end', 'exit:0']);
    expect(server.listening).toBe(false);
  });

  it('es idempotente: una segunda señal no repite el cierre', async () => {
    const server = await listenSlowApp(0);
    const pool = { end: jest.fn(async () => {}) };
    const exit = jest.fn();
    const shutdown = createShutdown({ server, pool, stopJobs: jest.fn(), exit });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('si el cierre no termina dentro del timeout fuerza la salida con 1', async () => {
    const server = { close: jest.fn() }; // nunca invoca el callback
    const exit = jest.fn();
    const shutdown = createShutdown({ server, pool: { end: jest.fn() }, stopJobs: jest.fn(), exit, timeoutMs: 30 });
    shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 80));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('con exitCode 1 (error fatal) sale con 1 tras cerrar', async () => {
    const server = await listenSlowApp(0);
    const exit = jest.fn();
    const shutdown = createShutdown({ server, pool: { end: jest.fn(async () => {}) }, stopJobs: jest.fn(), exit });
    await shutdown('uncaughtException', 1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('registerProcessHandlers', () => {
  it('engancha SIGTERM, SIGINT, unhandledRejection y uncaughtException', () => {
    const proc = { on: jest.fn() };
    const shutdown = jest.fn();
    registerProcessHandlers({ shutdown, proc });
    const events = proc.on.mock.calls.map((c) => c[0]);
    expect(events).toEqual(expect.arrayContaining(['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException']));

    const handler = (ev) => proc.on.mock.calls.find((c) => c[0] === ev)[1];
    handler('SIGTERM')();
    expect(shutdown).toHaveBeenLastCalledWith('SIGTERM', 0);
    handler('unhandledRejection')(new Error('boom'));
    expect(shutdown).toHaveBeenLastCalledWith('unhandledRejection', 1);
    expect(console.error).toHaveBeenCalled();
  });
});
