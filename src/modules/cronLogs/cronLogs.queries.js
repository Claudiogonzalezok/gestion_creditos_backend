const pool = require('../../config/db');

/**
 * Lista cronológica de ejecuciones de cron jobs.
 * @param {object} filters
 * @param {string|null} filters.jobName - Filtro exacto por job_name.
 * @param {string|null} filters.since   - ISO timestamp/date; trae ejecuciones >= a este punto.
 * @param {number}      filters.limit   - Máximo de filas a devolver.
 * @returns {Promise<object[]>}
 */
const getList = async ({ jobName, since, limit }) => {
  const r = await pool.query(
    `SELECT id, job_name, started_at, finished_at, success,
            affected_rows, error_message, metadata,
            CASE
              WHEN finished_at IS NULL THEN NULL
              ELSE EXTRACT(EPOCH FROM (finished_at - started_at))::float8
            END AS duration_seconds
     FROM cron_execution_log
     WHERE ($1::text      IS NULL OR job_name = $1)
       AND ($2::timestamptz IS NULL OR started_at >= $2)
     ORDER BY started_at DESC
     LIMIT $3`,
    [jobName || null, since || null, limit]
  );
  return r.rows;
};

/**
 * Última ejecución registrada por cada job_name conocido.
 * Hace LEFT JOIN contra el array de jobs esperados para que aparezcan
 * incluso los que nunca ejecutaron.
 *
 * Estados (derivados):
 *   · RUNNING       — finished_at IS NULL (started_at presente).
 *   · ERROR         — success = FALSE.
 *   · NO_RUN_TODAY  — última corrida exitosa pero anterior a CURRENT_DATE
 *                     (incluye jobs que nunca corrieron).
 *   · OK            — última corrida exitosa hoy.
 *
 * @param {string[]} knownJobs - Lista canónica de job_names del sistema.
 * @returns {Promise<object[]>}
 */
const getSummary = async (knownJobs) => {
  const r = await pool.query(
    `WITH expected AS (
       SELECT unnest($1::text[]) AS job_name
     ),
     latest_per_job AS (
       SELECT DISTINCT ON (job_name)
         job_name, started_at, finished_at, success,
         affected_rows, error_message, metadata
       FROM cron_execution_log
       ORDER BY job_name, started_at DESC
     )
     SELECT
       e.job_name,
       l.started_at    AS last_started_at,
       l.finished_at   AS last_finished_at,
       l.success       AS last_success,
       l.affected_rows AS last_affected_rows,
       l.error_message AS last_error_message,
       l.metadata      AS last_metadata,
       CASE
         WHEN l.finished_at IS NULL AND l.started_at IS NOT NULL THEN 'RUNNING'
         WHEN l.success = FALSE                                  THEN 'ERROR'
         WHEN l.started_at IS NULL                               THEN 'NO_RUN_TODAY'
         WHEN l.started_at::date < CURRENT_DATE                  THEN 'NO_RUN_TODAY'
         ELSE 'OK'
       END AS state,
       CASE
         WHEN l.finished_at IS NULL THEN NULL
         ELSE EXTRACT(EPOCH FROM (l.finished_at - l.started_at))::float8
       END AS last_duration_seconds
     FROM expected e
     LEFT JOIN latest_per_job l ON l.job_name = e.job_name
     ORDER BY e.job_name`,
    [knownJobs]
  );
  return r.rows;
};

module.exports = { getList, getSummary };
