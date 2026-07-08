// ══════════════════════════════════════════════════════════════════════════════
// Wrapper de auditoría para cron jobs.
// Cada corrida se registra en cron_execution_log con su inicio, fin, resultado
// y filas afectadas, permitiendo detectar jobs caídos, lentos o con errores.
//
// Contrato del callback:
//   · Puede devolver:
//       number                              → se guarda como affected_rows
//       { affected_rows, metadata? }        → ambos campos se guardan
//       undefined                            → success=true sin affected_rows
//   · Debe LANZAR si falla; el wrapper captura el error, lo registra y NO
//     lo re-propaga (los crons no deben tirar el servidor).
//
// Robustez:
//   · Si la inserción inicial falla (DB caída justo en el arranque), el job
//     igual se ejecuta. Lo único que se pierde es el registro de esa corrida.
//   · Si la actualización final falla, se loguea por consola pero el resto
//     del flujo sigue su curso.
// ══════════════════════════════════════════════════════════════════════════════

const pool = require('../config/db');

const normalizeResult = (result) => {
  if (typeof result === 'number') return { affectedRows: result, metadata: null };
  if (result && typeof result === 'object') {
    return {
      affectedRows: result.affected_rows ?? result.affectedRows ?? null,
      metadata:     result.metadata ?? null,
    };
  }
  return { affectedRows: null, metadata: null };
};

/**
 * Ejecuta un job de cron registrando inicio, fin y resultado en BD.
 * @param {string} jobName - Identificador del job (ej. 'overdueInstallments').
 * @param {() => Promise<any>} fn - Lógica del job. Debe lanzar para señalar error.
 * @returns {Promise<any>} El valor devuelto por fn, o undefined si lanzó.
 */
const runWithLogging = async (jobName, fn) => {
  const startedAt = new Date();

  let logId = null;
  try {
    const ins = await pool.query(
      `INSERT INTO cron_execution_log (job_name, started_at)
       VALUES ($1, $2)
       RETURNING id`,
      [jobName, startedAt]
    );
    logId = ins.rows[0].id;
  } catch (err) {
    console.error(`[CronLogger] No se pudo registrar inicio de ${jobName}: ${err.message}`);
  }

  try {
    const result = await fn();
    const { affectedRows, metadata } = normalizeResult(result);

    if (logId !== null) {
      await pool.query(
        `UPDATE cron_execution_log
         SET finished_at = NOW(), success = TRUE,
             affected_rows = $1, metadata = $2
         WHERE id = $3`,
        [affectedRows, metadata ? JSON.stringify(metadata) : null, logId]
      ).catch((err) => {
        console.error(`[CronLogger] No se pudo cerrar log #${logId} (${jobName}): ${err.message}`);
      });
    }
    return result;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`[${jobName}] Error:`, msg);

    if (logId !== null) {
      await pool.query(
        `UPDATE cron_execution_log
         SET finished_at = NOW(), success = FALSE, error_message = $1
         WHERE id = $2`,
        [msg, logId]
      ).catch((logErr) => {
        console.error(`[CronLogger] No se pudo registrar fallo de ${jobName}: ${logErr.message}`);
      });
    }
    // Intencionalmente no se re-propaga: los crons no deben tirar el servidor.
  }
};

module.exports = { runWithLogging };
