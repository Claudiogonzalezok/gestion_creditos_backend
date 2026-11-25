// Tests de configuración segura por defecto (issues #34 y #54).
//   · /api/docs solo existe fuera de producción.
//   · El arranque en producción falla con ENABLE_TEST_ROUTES=true o sin credenciales de BD.
//   · Las rutas de test siguen disponibles para E2E fuera de producción.
//   · /api/notifications se monta una sola vez.

jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));
// Evita conectar a PostgreSQL al cargar app.js.
jest.mock("../../src/config/db", () => ({ query: jest.fn(), connect: jest.fn() }));
// Router de notificaciones reemplazado por un contador: si se monta dos veces,
// una misma request lo atraviesa dos veces.
jest.mock("../../src/modules/notifications/notifications.routes", () => {
  const counter = (req, res, next) => {
    counter.hits += 1;
    next();
  };
  counter.hits = 0;
  return counter;
});

// La primera carga en frío de app.js (swagger + todos los módulos) puede superar 5 s.
jest.setTimeout(20000);

const request = require("supertest");
const { validateSecureConfig } = require("../../src/config/secureConfig");

const KEYS = ["NODE_ENV", "ENABLE_TEST_ROUTES", "DB_USER", "DB_PASSWORD"];
const saved = {};

beforeEach(() => KEYS.forEach((k) => (saved[k] = process.env[k])));
afterEach(() =>
  KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }),
);

/**
 * Carga una instancia fresca de app.js con el entorno indicado.
 * @param {Object} env - variables a fijar (undefined = borrar)
 * @returns {{app: Object, notifications: Function}}
 */
const loadApp = (env) => {
  Object.entries(env).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  let app;
  let notifications;
  jest.isolateModules(() => {
    app = require("../../src/app");
    notifications = require("../../src/modules/notifications/notifications.routes");
  });
  return { app, notifications };
};

const PROD_OK = {
  NODE_ENV: "production",
  ENABLE_TEST_ROUTES: undefined,
  DB_USER: "app_user",
  DB_PASSWORD: "s3cret",
};
const DEV = { ...PROD_OK, NODE_ENV: "development" };

describe("/api/docs (#34)", () => {
  it("devuelve 404 con NODE_ENV=production", async () => {
    const res = await request(loadApp(PROD_OK).app).get("/api/docs/");
    expect(res.status).toBe(404);
  });

  it("sigue disponible en desarrollo", async () => {
    const res = await request(loadApp(DEV).app).get("/api/docs/");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/swagger/i);
  });

  it("no rompe otras rutas en producción (health)", async () => {
    const res = await request(loadApp(PROD_OK).app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("arranque en producción (#54)", () => {
  it("falla con ENABLE_TEST_ROUTES=true", () => {
    expect(() => loadApp({ ...PROD_OK, ENABLE_TEST_ROUTES: "true" })).toThrow(
      /ENABLE_TEST_ROUTES/,
    );
  });

  it("falla sin DB_USER", () => {
    expect(() => loadApp({ ...PROD_OK, DB_USER: undefined })).toThrow(/DB_USER/);
  });

  it("falla con DB_PASSWORD vacío", () => {
    expect(() => loadApp({ ...PROD_OK, DB_PASSWORD: "" })).toThrow(/DB_PASSWORD/);
  });

  it("arranca con configuración segura", () => {
    expect(() => loadApp(PROD_OK)).not.toThrow();
  });
});

describe("validateSecureConfig", () => {
  it("fuera de producción no exige credenciales (dev local y E2E)", () => {
    expect(() =>
      validateSecureConfig({ NODE_ENV: "development", ENABLE_TEST_ROUTES: "true" }),
    ).not.toThrow();
    expect(() => validateSecureConfig({})).not.toThrow();
  });

  it("reporta todos los problemas juntos", () => {
    expect(() =>
      validateSecureConfig({ NODE_ENV: "production", ENABLE_TEST_ROUTES: "true" }),
    ).toThrow(/ENABLE_TEST_ROUTES[\s\S]*DB_USER[\s\S]*DB_PASSWORD/);
  });
});

describe("montaje de routers (#54)", () => {
  it("con ENABLE_TEST_ROUTES=true fuera de producción /api/test sigue montada (dev:e2e)", async () => {
    const { app } = loadApp({ ...DEV, ENABLE_TEST_ROUTES: "true" });
    // Montada: exige autenticación (401) en lugar del 404 global.
    const res = await request(app).delete("/api/test/business-days/today");
    expect(res.status).toBe(401);
  });

  it("sin el flag, /api/test no existe", async () => {
    const res = await request(loadApp(DEV).app).delete(
      "/api/test/business-days/today",
    );
    expect(res.status).toBe(404);
  });

  it("/api/notifications se monta una sola vez", async () => {
    const { app, notifications } = loadApp(DEV);
    await request(app).get("/api/notifications/x");
    expect(notifications.hits).toBe(1);
  });
});
