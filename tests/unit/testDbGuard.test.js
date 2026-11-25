// Tests de la guarda que impide correr integración contra una base que no es de test.
const {
  assertTestDatabase,
  loadTestEnv,
} = require("../integration/helpers/testDbGuard");

describe("loadTestEnv", () => {
  const saved = {};
  const KEYS = ["NODE_ENV", "DB_NAME"];

  beforeEach(() => KEYS.forEach((k) => (saved[k] = process.env[k])));
  afterEach(() =>
    KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }),
  );

  it("no deja que .env.test pise una base real ya definida en el entorno", () => {
    process.env.NODE_ENV = "test";
    process.env.DB_NAME = "gestion_creditos";
    expect(() => loadTestEnv()).toThrow(/gestion_creditos/);
  });

  it("con .env.test y sin variables previas, acepta la base de test", () => {
    delete process.env.NODE_ENV;
    delete process.env.DB_NAME;
    expect(() => loadTestEnv()).not.toThrow();
    expect(process.env.DB_NAME).toBe("gestion_creditos_test");
  });
});

describe("assertTestDatabase", () => {
  it("acepta NODE_ENV=test con una base terminada en _test", () => {
    expect(() =>
      assertTestDatabase({ NODE_ENV: "test", DB_NAME: "gestion_creditos_test" }),
    ).not.toThrow();
  });

  it("rechaza la base de producción aunque NODE_ENV sea test", () => {
    expect(() =>
      assertTestDatabase({ NODE_ENV: "test", DB_NAME: "gestion_creditos" }),
    ).toThrow(/gestion_creditos/);
  });

  it("rechaza cuando falta .env.test (NODE_ENV sin definir)", () => {
    expect(() =>
      assertTestDatabase({ DB_NAME: "gestion_creditos_test" }),
    ).toThrow(/NODE_ENV/);
  });

  it("rechaza cuando DB_NAME no está definido", () => {
    expect(() => assertTestDatabase({ NODE_ENV: "test" })).toThrow(/DB_NAME/);
  });

  it("rechaza nombres que solo contienen test en el medio", () => {
    expect(() =>
      assertTestDatabase({ NODE_ENV: "test", DB_NAME: "test_produccion" }),
    ).toThrow();
  });
});
