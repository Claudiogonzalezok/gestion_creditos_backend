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
  'payments',
  'credit_refinancings',
  'credit_down_payments',
  'credit_products',
  'installments',
  'commission_liquidations',
  'commissions',
  'credits',
  'customers',
];

/**
 * Limpia todas las tablas transaccionales. Reset de identity para que los
 * SERIAL arranquen siempre en 1 (útil para cron_execution_log que tiene
 * SERIAL PRIMARY KEY).
 */
const truncateAll = async () => {
  await pool.query(
    `TRUNCATE TABLE ${TRANSACTIONAL_TABLES.join(', ')} RESTART IDENTITY CASCADE`
  );
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
