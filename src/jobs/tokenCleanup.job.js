// Elimina tokens expirados de token_blacklist y refresh_tokens.
// Se ejecuta todos los días a las 04:00 hs.

const cron = require('node-cron');
const { cleanExpiredTokens, cleanExpiredRefreshTokens } = require('../modules/auth/auth.queries');
const { runWithLogging, ts } = require('../utils/cronLogger');

const runCleanup = () => runWithLogging('tokenCleanup', async () => {
  const [deletedBl, deletedRt] = await Promise.all([
    cleanExpiredTokens(),
    cleanExpiredRefreshTokens(),
  ]);
  console.log(`[${ts()}] [JOB tokenCleanup] Blacklist: ${deletedBl} eliminado(s). RefreshTokens: ${deletedRt} eliminado(s).`);
  return {
    affected_rows: deletedBl + deletedRt,
    metadata: { blacklist: deletedBl, refresh_tokens: deletedRt },
  };
});

const start = () => {
  cron.schedule('0 4 * * *', runCleanup, {
    timezone: process.env.TZ || 'America/Argentina/Buenos_Aires',
  });
  console.log(`[${ts()}] [JOB tokenCleanup] Programado — todos los días a las 04:00.`);
};

module.exports = { start, runCleanup };
