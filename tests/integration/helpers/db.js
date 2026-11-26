// Helpers de DB para tests de integración.
// Reusa el pool real de src/config/db.js (configurado vía .env.test).
//
// Patrón de uso típico en cada test file:
//
//     const { setupTestSuite } = require('./helpers/db');
//     setupTestSuite();    // registra beforeEach (truncate) y afterAll (close)
//
//     describe('mi feature', () => {
//       it('...', async () => {
//         const pool = require('../../src/config/db');
//         ...
//       });
//     });


// Importante: cargar .env.test ANTES de require('src/config/db'),
// porque el pool se crea al momento del require leyendo process.env.
// La guarda aborta si la base no es de test, antes de crear el pool.
const { loadTestEnv, assertTestDatabase } = require("./testDbGuard");
loadTestEnv();

const pool = require("../../../src/config/db");

// Tablas transaccionales que se truncan entre tests.
// Se ordenan por dependencia (la primera no referencia a las siguientes),
// pero TRUNCATE ... CASCADE limpia FKs automáticamente, así que el orden
// es solo documental.
const TRANSACTIONAL_TABLES = [
  "cron_execution_log",
  "notifications",
  // notification_preferences NO se trunca: la migración 039 inyecta el seed
  // de las 6 filas default (una por tipo). Es config global, no transaccional.
  "collection_attempts",
  "collection_sheet_details",
  "collection_sheets",
  "cash_movements",
  "cash_account_movements",
  "cash_session_closure_details",
  "cash_session_drops",
  "cash_sessions",
  "business_days",
  // branches NO se trunca: la migración 023 inyecta una sucursal default 'HQ'
  // necesaria para abrir cajas. Se queda intacta entre tests.
  // cash_accounts TAMPOCO se trunca: la migración 025 inyecta la seed
  // 'Caja General' obligatoria. current_balance se resetea en truncateAll.
  "payments",
  "credit_refinancings",
  "credit_down_payments",
  "credit_products",
  "installments",
  "commission_liquidations",
  "commissions",
  "credits",
  "customers",
  // users entra acá porque las fixtures crean admins/cobradores. CASCADE
  // limpia cualquier referencia desde otras tablas. No interfiere con seeds:
  // el test DB solo corre migrations, no seeds, así que la tabla arranca vacía.
  "users",
];

/**
 * Limpia todas las tablas transaccionales. Reset de identity para que los
 * SERIAL arranquen siempre en 1 (útil para cron_execution_log que tiene
 * SERIAL PRIMARY KEY).
 *
 * Nota: truncar users con CASCADE también limpia system_config (que tiene FK
 * updated_by → users). Re-seedea las claves críticas para que los tests no
 * fallen al leer parámetros financieros.
 */
const truncateAll = async () => {
  // Re-verificación defensiva justo antes del TRUNCATE CASCADE.
  assertTestDatabase();
  await pool.query(
    `TRUNCATE TABLE ${TRANSACTIONAL_TABLES.join(", ")} RESTART IDENTITY CASCADE`,
  );
  // Resetear current_balance: cash_accounts no se trunca (preserva seed),
  // pero su balance cacheado tiene que arrancar en 0 en cada test.
  await pool.query(`UPDATE cash_accounts SET current_balance = 0`);
  await reseedSystemConfig();
};

/**
 * Re-inserta las DEFAULT_VALUES de system_config tras un truncate cascade.
 * Idempotente vía ON CONFLICT DO NOTHING.
 */
const reseedSystemConfig = async () => {
  const {
    DEFAULT_VALUES,
  } = require("../../../src/modules/systemConfig/systemConfig.queries");
  for (const [key, def] of Object.entries(DEFAULT_VALUES)) {
    await pool.query(
      `INSERT INTO system_config (key, value, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, def.value, def.description],
    );
  }
};

/**
 * Fija un parámetro de system_config para el test en curso e invalida el caché
 * de `getValue` (sin esto el código bajo prueba sigue leyendo el valor anterior,
 * porque getValue cachea con TTL de 5 minutos).
 *
 * No hace falta restaurar: `truncateAll` corre en cada beforeEach y vuelve a
 * dejar los DEFAULT_VALUES.
 *
 * @param {string} key - Clave de system_config (debe existir en DEFAULT_VALUES).
 * @param {string|number} value
 */
const setConfig = async (key, value) => {
  const { rowCount } = await pool.query(
    `UPDATE system_config SET value = $2 WHERE key = $1`,
    [key, String(value)],
  );
  if (!rowCount) throw new Error(`setConfig: system_config no tiene la clave "${key}"`);
  require("../../../src/utils/cache").clearAll();
};

/**
 * Pequeño helper: ejecuta una función con un client dedicado en transacción.
 * Útil para invocar queries que requieren `client` sin que el test maneje
 * el lock/release.
 */
const withTestClient = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Registra los hooks estándar de cada test suite de integration:
 *   · beforeEach → trunca tablas transaccionales para aislamiento.
 *   · afterAll  → cierra el pool de esta suite para no dejar handles colgados.
 *
 * Llamar UNA VEZ al tope de cada test file, fuera de `describe`.
 */
const setupTestSuite = () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    // Cada test file tiene su propio registro de módulos y por lo tanto su
    // propio pool: se cierra acá (globalTeardown corre en otro contexto).
    await pool.end().catch(() => {});
  });
};

/**
 * Preserva una tabla de referencia (no truncada entre tests) que una suite
 * modifica: guarda sus filas en beforeAll y las restaura en afterAll, para que
 * los cambios no se filtren a otras suites. Llamar antes de setupTestSuite(),
 * así su afterAll corre antes del cierre del pool.
 * Solo para tablas sin FKs entrantes (p.ej. interest_rates).
 * @param {string} table - nombre de la tabla (literal fijo, no input externo)
 */
const preserveTable = (table) => {
  // null = el snapshot no llegó a tomarse. En ese caso NO se restaura:
  // restaurar un snapshot vacío borraría toda la tabla.
  let snapshot = null;

  beforeAll(async () => {
    snapshot = await snapshotTable(table);
  });

  afterAll(async () => {
    if (snapshot === null) return;
    await restoreTable(table, snapshot);
  });
};

/**
 * Devuelve todas las filas actuales de una tabla de referencia, ordenadas por
 * `id` para que dos snapshots de las mismas filas sean comparables (sin ORDER BY
 * el orden depende del layout físico y cambia tras DELETE + INSERT).
 * @param {string} table - nombre de la tabla (literal fijo, no input externo; debe tener columna id)
 * @returns {Promise<Object[]>}
 */
const snapshotTable = async (table) =>
  (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;

/**
 * Reemplaza el contenido de la tabla por las filas del snapshot, en una sola
 * transacción: si algo falla, la tabla queda como estaba (ni vacía ni a medias).
 * @param {string} table - nombre de la tabla (literal fijo, no input externo)
 * @param {Object[]} snapshot - filas devueltas por snapshotTable
 */
const restoreTable = async (table, snapshot) => {
  assertTestDatabase();
  await withTestClient(async (client) => {
    await client.query(`DELETE FROM ${table}`);
    for (const row of snapshot) {
      const cols = Object.keys(row);
      const params = cols.map((_, i) => `$${i + 1}`).join(", ");
      await client.query(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${params})`,
        cols.map((c) => row[c]),
      );
    }
  });
};

module.exports = {
  pool,
  truncateAll,
  withTestClient,
  setupTestSuite,
  preserveTable,
  snapshotTable,
  restoreTable,
  setConfig,
};
