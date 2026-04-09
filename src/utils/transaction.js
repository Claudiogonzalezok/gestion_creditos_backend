const pool = require('../config/db');

/**
 * Ejecuta un callback dentro de una transacción PostgreSQL.
 * Hace ROLLBACK automático si el callback lanza un error.
 * @param {Function} callback - async (client) => result
 */
const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { withTransaction };
