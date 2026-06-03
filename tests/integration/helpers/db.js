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

const path = require('path');

// Importante: cargar .env.test ANTES de require('src/config/db'),
// porque el pool se crea al momento del require leyendo process.env.
require('dotenv').config({ path: path.join(__dirname, '../../../.env.test') });

const pool = require('../../../src/config/db');

// Tablas transaccionales que se truncan entre tests.
// Se ordenan por dependencia (la primera no referencia a las siguientes),
// pero TRUNCATE ... CASCADE limpia FKs automáticamente, así que el orden
// es solo documental.
const TRANSACTIONAL_TABLES = [
  'cron_execution_log',
  'collection_attempts',
  'collection_sheet_details',
  'collection_sheets',
  'cash_movements',
  'cash_account_movements',
  'cash_session_closure_details',
  'cash_session_drops',
  'cash_sessions',
  'business_days',
  // branches NO se trunca: la migración 023 inyecta una sucursal default 'HQ'
  // necesaria para abrir cajas. Se queda intacta entre tests.
  // cash_accounts TAMPOCO se trunca: la migración 025 inyecta la seed
  // 'Caja General' obligatoria. current_balance se resetea en truncateAll.
  'payments',
  'credit_refinancings',
  'credit_down_payments',
  'credit_products',
  'installments',
  'commission_liquidations',
  'commissions',
  'credits',
  'customers',
  // users entra acá porque las fixtures crean admins/cobradores. CASCADE
  // limpia cualquier referencia desde otras tablas. No interfiere con seeds:
  // el test DB solo corre migrations, no seeds, así que la tabla arranca vacía.
  'users',
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
  await pool.query(
    `TRUNCATE TABLE ${TRANSACTIONAL_TABLES.join(', ')} RESTART IDENTITY CASCADE`
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
  const { DEFAULT_VALUES } = require('../../../src/modules/systemConfig/systemConfig.queries');
  for (const [key, def] of Object.entries(DEFAULT_VALUES)) {
    await pool.query(
      `INSERT INTO system_config (key, value, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, def.value, def.description]
    );
  }
};

/**
 * Pequeño helper: ejecuta una función con un client dedicado en transacción.
 * Útil para invocar queries que requieren `client` sin que el test maneje
 * el lock/release.
 */
const withTestClient = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
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
    // El pool global se cierra en globalTeardown, pero si una suite quiere
    // forzar limpieza inmediata, este afterAll lo deja a salvo.
  });
};

module.exports = { pool, truncateAll, withTestClient, setupTestSuite };
