// Elimina tokens JWT expirados de la blacklist para mantener el rendimiento
// de la verificación de sesión. Se ejecuta todos los días a las 04:00 hs.

const cron = require('node-cron');
const { cleanExpiredTokens } = require('../modules/auth/auth.queries');

const runCleanup = async () => {
  try {
    const deleted = await cleanExpiredTokens();
    if (deleted > 0)
      console.log(`[JOB tokenCleanup] ${deleted} token(s) expirado(s) eliminado(s).`);
    else
      console.log('[JOB tokenCleanup] Sin tokens expirados para eliminar.');
  } catch (err) {
    console.error('[JOB tokenCleanup] Error:', err.message);
  }
};

const start = () => {
  cron.schedule('0 4 * * *', runCleanup, {
    timezone: process.env.TZ || 'America/Argentina/Buenos_Aires',
  });
  console.log('[JOB tokenCleanup] Programado — todos los días a las 04:00.');
};

module.exports = { start, runCleanup };
