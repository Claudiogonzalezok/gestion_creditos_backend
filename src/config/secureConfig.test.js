// Unitarios de la configuración segura por defecto (#34, #54).
// El comportamiento sobre app.js se cubre en tests/integration/secureDefaults.test.js.
const {
  isDocsEnabled,
  areTestRoutesEnabled,
  validateSecureConfig,
} = require("./secureConfig");

const PROD_OK = { NODE_ENV: "production", DB_USER: "app", DB_PASSWORD: "x" };

describe("secureConfig", () => {
  it("docs solo fuera de producción", () => {
    expect(isDocsEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(isDocsEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isDocsEnabled({})).toBe(true);
  });

  it("rutas de test requieren el flag y nunca en producción", () => {
    expect(areTestRoutesEnabled({ ENABLE_TEST_ROUTES: "true" })).toBe(true);
    expect(areTestRoutesEnabled({})).toBe(false);
    expect(
      areTestRoutesEnabled({ NODE_ENV: "production", ENABLE_TEST_ROUTES: "true" }),
    ).toBe(false);
  });

  it("producción segura no falla; fuera de producción no exige nada", () => {
    expect(() => validateSecureConfig(PROD_OK)).not.toThrow();
    expect(() =>
      validateSecureConfig({ NODE_ENV: "development", ENABLE_TEST_ROUTES: "true" }),
    ).not.toThrow();
  });

  it.each([
    [{ ENABLE_TEST_ROUTES: "true" }, /ENABLE_TEST_ROUTES/],
    [{ DB_USER: undefined }, /DB_USER/],
    [{ DB_USER: "  " }, /DB_USER/],
    [{ DB_PASSWORD: "" }, /DB_PASSWORD/],
  ])("producción falla con %o", (override, msg) => {
    expect(() => validateSecureConfig({ ...PROD_OK, ...override })).toThrow(msg);
  });
});
