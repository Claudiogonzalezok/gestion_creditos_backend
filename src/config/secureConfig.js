/**
 * Configuración segura por defecto (issues #34 y #54).
 * Centraliza qué superficies se exponen según el entorno y valida al arranque
 * que producción no corra con flags inseguros ni credenciales vacías.
 */

/**
 * Indica si el entorno es producción.
 * @param {Object} env - variables de entorno (por defecto process.env)
 * @returns {boolean}
 */
const isProduction = (env = process.env) => env.NODE_ENV === "production";

/**
 * La documentación Swagger solo se expone fuera de producción.
 * @param {Object} env
 * @returns {boolean}
 */
const isDocsEnabled = (env = process.env) => !isProduction(env);

/**
 * Las rutas de test requieren el flag explícito y nunca se montan en producción.
 * @param {Object} env
 * @returns {boolean}
 */
const areTestRoutesEnabled = (env = process.env) =>
  env.ENABLE_TEST_ROUTES === "true" && !isProduction(env);

/**
 * Falla el arranque en producción si la configuración es insegura.
 * Fuera de producción no exige nada (dev local, tests y `dev:e2e`).
 * @param {Object} env
 * @throws {Error} con todos los problemas detectados
 */
const validateSecureConfig = (env = process.env) => {
  if (!isProduction(env)) return;

  const problems = [];
  if (env.ENABLE_TEST_ROUTES === "true") {
    problems.push("ENABLE_TEST_ROUTES=true no está permitido en producción");
  }
  if (!env.DB_USER || !env.DB_USER.trim()) {
    problems.push("DB_USER es obligatorio en producción");
  }
  if (!env.DB_PASSWORD) {
    problems.push("DB_PASSWORD es obligatorio en producción");
  }

  if (problems.length) {
    throw new Error(`Configuración insegura: ${problems.join("; ")}.`);
  }
};

module.exports = {
  isProduction,
  isDocsEnabled,
  areTestRoutesEnabled,
  validateSecureConfig,
};
