const pool = require('../config/db');

/**
 * Ejecuta ROLLBACK sin lanzar: si falla (conexión caída), lo loguea y devuelve
 * el error para que el llamador libere el cliente con él y el pool lo descarte.
 * Nunca reemplaza al error original de la transacción.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<Error|null>} El error del ROLLBACK, o null si funcionó.
 */
const rollbackSafely = async (client) => {
  try {
    await client.query('ROLLBACK');
    return null;
  } catch (rollbackErr) {
    console.error('🔴  Falló el ROLLBACK (se descarta la conexión):', rollbackErr.message);
    return rollbackErr;
  }
};

/**
 * Libera el cliente al pool; si hubo un error de conexión lo pasa a release
 * para que el pool destruya el cliente en lugar de reutilizarlo.
 * @param {import('pg').PoolClient} client
 * @param {Error|null} connectionErr
 */
const releaseClient = (client, connectionErr) => {
  if (connectionErr) client.release(connectionErr);
  else client.release();
};

/**
 * Ejecuta un callback dentro de una transacción PostgreSQL.
 * Hace ROLLBACK automático si el callback lanza un error y relanza siempre
 * el error original, aunque el ROLLBACK falle.
 * @param {Function} callback - async (client) => result
 */
const withTransaction = async (callback) => {
  const client = await pool.connect();
  let connectionErr = null;
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    connectionErr = await rollbackSafely(client);
    throw err;
  } finally {
    releaseClient(client, connectionErr);
  }
};

module.exports = { withTransaction, rollbackSafely, releaseClient };
