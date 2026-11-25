// Guarda de seguridad para los tests de integración.
// Los tests truncan tablas (TRUNCATE ... CASCADE): si apuntaran a una base real
// borrarían usuarios, créditos y pagos. Esta guarda se ejecuta ANTES de crear
// cualquier pool o conexión, y no depende de que exista .env.test.

const path = require("path");

const TEST_DB_SUFFIX = "_test";

/**
 * Lanza un error si el entorno no apunta a una base de datos de test.
 * Exige NODE_ENV=test y que DB_NAME termine en "_test".
 * @param {Object} env - variables de entorno a validar (default: process.env)
 */
const assertTestDatabase = (env = process.env) => {
  if (env.NODE_ENV !== "test") {
    throw new Error(
      `[integration] Abortado: NODE_ENV debe ser "test" (actual: "${env.NODE_ENV ?? ""}"). ` +
        `¿Falta .env.test?`,
    );
  }
  const dbName = env.DB_NAME;
  if (!dbName) {
    throw new Error("[integration] Abortado: DB_NAME no está definido.");
  }
  if (!dbName.endsWith(TEST_DB_SUFFIX)) {
    throw new Error(
      `[integration] Abortado: DB_NAME "${dbName}" no es una base de test ` +
        `(debe terminar en "${TEST_DB_SUFFIX}"). No se ejecutó ninguna query.`,
    );
  }
};

/**
 * Carga .env.test (sin pisar variables ya definidas, para que los scripts
 * :local puedan fijar host/puerto) y valida que la base sea de test.
 */
const loadTestEnv = () => {
  require("dotenv").config({ path: path.join(__dirname, "../../../.env.test") });
  assertTestDatabase();
};

module.exports = { assertTestDatabase, loadTestEnv };
