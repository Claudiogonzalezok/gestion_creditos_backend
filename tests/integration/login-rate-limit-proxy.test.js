// Rate limit de login detrás de nginx (issue #35).
//   · Con trust proxy = loopback, cada cliente cuenta por su IP real
//     (X-Forwarded-For): agotar el límite de uno no bloquea a los demás.
//   · El mensaje 429 refleja la ventana real configurada.

jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));
jest.mock("../../src/config/db", () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  connect: jest.fn(),
}));
jest.setTimeout(20000);

const request = require("supertest");

const KEYS = [
  "NODE_ENV", "TRUST_PROXY", "DISABLE_LOGIN_RATE_LIMIT",
  "LOGIN_RATE_LIMIT_MAX", "LOGIN_RATE_LIMIT_WINDOW_MS",
];
const saved = {};
beforeEach(() => KEYS.forEach((k) => (saved[k] = process.env[k])));
afterEach(() =>
  KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }),
);

/** Carga app.js fresca con el entorno indicado (undefined = borrar). */
const loadApp = (env) => {
  Object.entries(env).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  let app;
  jest.isolateModules(() => {
    app = require("../../src/app");
  });
  return app;
};

const BASE = {
  NODE_ENV: "development",
  DISABLE_LOGIN_RATE_LIMIT: undefined,
  LOGIN_RATE_LIMIT_MAX: "2",
  LOGIN_RATE_LIMIT_WINDOW_MS: String(5 * 60 * 1000),
};

const login = (app, ip) =>
  request(app)
    .post("/api/auth/login")
    .set("X-Forwarded-For", ip)
    .send({ dni: "12345678", password: "x" });

describe("rate limit de login con trust proxy", () => {
  it("default loopback: cuenta por IP real del cliente, no por la del proxy", async () => {
    const app = loadApp({ ...BASE, TRUST_PROXY: undefined });
    expect(app.get("trust proxy")).toBe("loopback");

    await login(app, "203.0.113.10");
    await login(app, "203.0.113.10");
    const blocked = await login(app, "203.0.113.10");
    expect(blocked.status).toBe(429);

    // Otro cliente detrás del mismo nginx sigue pudiendo intentar.
    const other = await login(app, "198.51.100.20");
    expect(other.status).not.toBe(429);
  });

  it("el mensaje 429 refleja la ventana configurada (5 minutos), no un 15 fijo", async () => {
    const app = loadApp({ ...BASE, TRUST_PROXY: undefined });
    await login(app, "203.0.113.11");
    await login(app, "203.0.113.11");
    const res = await login(app, "203.0.113.11");
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      ok: false,
      message: "Demasiados intentos de acceso. Intentá nuevamente en 5 minutos.",
    });
  });

  it("TRUST_PROXY=false: ignora X-Forwarded-For (todos comparten la IP del socket)", async () => {
    const app = loadApp({ ...BASE, TRUST_PROXY: "false" });
    expect(app.get("trust proxy")).toBe(false);
    await login(app, "203.0.113.12");
    await login(app, "203.0.113.13");
    const res = await login(app, "203.0.113.14");
    expect(res.status).toBe(429);
  });
});
