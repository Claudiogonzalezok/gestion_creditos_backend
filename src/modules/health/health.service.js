const pool = require('../../config/db');

/**
 * Verifica que PostgreSQL responda a SELECT 1 dentro del timeout.
 * @param {number} timeoutMs - Tiempo máximo de espera.
 * @returns {Promise<boolean>} true si la base respondió a tiempo.
 */
const isDatabaseUp = async (timeoutMs) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`SELECT 1 superó ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([pool.query('SELECT 1'), timeout]);
    return true;
  } catch (err) {
    console.error('🔴  Health check: base de datos no disponible:', err.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
};

module.exports = { isDatabaseUp };
