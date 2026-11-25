// Exclusión mutua entre procesos para cron jobs vía advisory locks de sesión.
// Si PM2 corre en cluster (o hay dos instancias), cada proceso agenda los
// mismos crons: el lock garantiza que una sola instancia ejecute cada corrida.

const pool = require('../config/db');
const { releaseClient } = require('./transaction');

/**
 * Ejecuta fn solo si se obtiene el advisory lock asociado a name.
 * El lock es de sesión: se toma y se libera sobre la misma conexión dedicada.
 * @param {string} name - Identificador del lock (ej. nombre del job).
 * @param {() => Promise<any>} fn
 * @returns {Promise<{acquired: true, result: any}|{acquired: false}>}
 *   acquired=false si otro proceso tiene el lock (fn no se ejecuta).
 */
const withAdvisoryLock = async (name, fn) => {
  const key = `cron:${name}`;
  const client = await pool.connect();
  let connectionErr = null;
  try {
    let lock;
    try {
      lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [key]);
    } catch (lockErr) {
      connectionErr = lockErr;
      throw lockErr;
    }
    if (!lock.rows[0].acquired) return { acquired: false };

    try {
      return { acquired: true, result: await fn() };
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } catch (unlockErr) {
        // Si no se pudo liberar, se descarta la conexión: al cerrarse la sesión
        // PostgreSQL libera el lock igual.
        console.error(`🔴  No se pudo liberar el lock ${key}:`, unlockErr.message);
        connectionErr = unlockErr;
      }
    }
  } finally {
    releaseClient(client, connectionErr);
  }
};

module.exports = { withAdvisoryLock };
