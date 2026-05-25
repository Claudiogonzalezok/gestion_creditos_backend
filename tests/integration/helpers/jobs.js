// Helpers para ejecutar cron jobs en tests.
//
// Los jobs en src/jobs/*.js exponen su lógica envuelta por runWithLogging
// (cronLogger). Para tests queremos:
//   · Disparar la lógica del job.
//   · Obtener su resultado (affected_rows, metadata) sin acceder a la tabla
//     cron_execution_log (aunque también podemos consultarla si interesa).
//
// `runJobOnce(jobFn)` invoca el job tal cual lo programaría el cron. El
// wrapper igual escribe en cron_execution_log, lo que es útil para tests
// del logger en sí. Devuelve el resultado retornado por la lógica del job.

/**
 * Ejecuta una función de job (de src/jobs/) tal como la corre el cron.
 * @param {() => Promise<any>} jobFn
 * @returns {Promise<any>} El valor que el job retornó (forwardeado por runWithLogging).
 */
const runJobOnce = async (jobFn) => {
  return jobFn();
};

/**
 * Devuelve el último registro de cron_execution_log para un job dado.
 * Útil para verificar instrumentación.
 * @param {string} jobName
 * @returns {Promise<object|null>}
 */
const getLastCronLog = async (jobName) => {
  const { pool } = require('./db');
  const r = await pool.query(
    `SELECT id, job_name, started_at, finished_at, success,
            affected_rows, error_message, metadata
     FROM cron_execution_log
     WHERE job_name = $1
     ORDER BY id DESC
     LIMIT 1`,
    [jobName]
  );
  return r.rows[0] || null;
};

module.exports = { runJobOnce, getLastCronLog };
