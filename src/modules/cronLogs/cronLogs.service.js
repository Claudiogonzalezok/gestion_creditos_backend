const queries = require('./cronLogs.queries');

// Lista canónica de jobs que corren en src/jobs/.
// Aparecen en el summary aunque no hayan ejecutado todavía (state=NO_RUN_TODAY).
// Mantener sincronizada con los nombres pasados a runWithLogging() en cada job.
const KNOWN_JOBS = [
  'overdueInstallments',
  'creditExpiry',
  'tokenCleanup',
  'weeklyCommissionCycle',
];

const MAX_LIMIT     = 500;
const DEFAULT_LIMIT = 50;

/**
 * Lista ejecuciones de cron jobs con filtros opcionales.
 * @param {object} params
 * @param {string} [params.job_name]
 * @param {string} [params.since]  - ISO timestamp/date
 * @param {number} [params.limit]  - default 50, max 500
 */
const list = async ({ job_name, since, limit } = {}) => {
  const safeLimit = Math.min(parseInt(limit) || DEFAULT_LIMIT, MAX_LIMIT);
  return queries.getList({
    jobName: job_name || null,
    since:   since    || null,
    limit:   safeLimit,
  });
};

/**
 * Resumen del último estado de cada job conocido.
 */
const summary = async () => {
  return queries.getSummary(KNOWN_JOBS);
};

module.exports = { list, summary, KNOWN_JOBS };
