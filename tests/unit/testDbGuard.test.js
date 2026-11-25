// Tests de la guarda que impide correr integración contra una base que no es de test.
const { assertTestDatabase } = require("../integration/helpers/testDbGuard");

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
