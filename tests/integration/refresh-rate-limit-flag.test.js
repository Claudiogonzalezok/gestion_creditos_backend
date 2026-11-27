// #120 — DISABLE_LOGIN_RATE_LIMIT también apaga el límite de refresh.
//   · Sin el flag: el pedido 61 a /auth/refresh (o /auth/portal/refresh)
//     en la ventana responde 429, como hasta ahora.
//   · Con el flag: no hay límite en ninguno de los dos.

jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));
jest.mock("../../src/config/db", () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  connect: jest.fn(),
}));
jest.setTimeout(30000);

const request = require("supertest");

const KEYS = ["NODE_ENV", "DISABLE_LOGIN_RATE_LIMIT"];
const saved = {};
beforeEach(() => KEYS.forEach((k) => (saved[k] = process.env[k])));
afterEach(() =>
  KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }),
);

/** Carga app.js fresca con el flag indicado (undefined = borrar). */
const loadApp = (flag) => {
  process.env.NODE_ENV = "development";
  if (flag === undefined) delete process.env.DISABLE_LOGIN_RATE_LIMIT;
  else process.env.DISABLE_LOGIN_RATE_LIMIT = flag;
  let app;
  jest.isolateModules(() => {
    app = require("../../src/app");
  });
  return app;
};

/** Hace n refresh sin cookie y devuelve el status del último. */
const lastStatusAfter = async (app, path, n) => {
  let status;
  for (let i = 0; i < n; i++) status = (await request(app).post(path)).status;
  return status;
};

describe.each(["/api/auth/refresh", "/api/auth/portal/refresh"])("%s", (path) => {
  it("No romper: sin el flag, el pedido 61 en la ventana → 429", async () => {
    const app = loadApp(undefined);
    expect(await lastStatusAfter(app, path, 60)).toBe(401);
    expect((await request(app).post(path)).status).toBe(429);
  });

  it("con DISABLE_LOGIN_RATE_LIMIT=true no hay límite", async () => {
    const app = loadApp("true");
    expect(await lastStatusAfter(app, path, 61)).toBe(401);
  });
});
