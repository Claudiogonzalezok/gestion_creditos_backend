// Ciclo de vida del proceso: arranque del servidor + cron jobs y cierre ordenado.
//   · SIGTERM/SIGINT (PM2 stop/reload, Ctrl+C): deja de aceptar conexiones,
//     espera a que terminen las requests en curso, detiene los cron, cierra el
//     pool y sale con 0. Si no termina en SHUTDOWN_TIMEOUT_MS, fuerza salida 1.
//   · unhandledRejection/uncaughtException: loguea y hace el mismo cierre con 1
//     (el proceso queda en estado incierto; PM2 lo reinicia).

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

/**
 * Crea la función de cierre ordenado. Es idempotente: una segunda señal
 * durante el cierre devuelve la misma promesa.
 * @param {Object} deps
 * @param {import('http').Server} deps.server
 * @param {{ end: Function }} deps.pool - Pool de PostgreSQL.
 * @param {Function} deps.stopJobs - Detiene los cron programados.
 * @param {Function} [deps.exit] - process.exit (inyectable para tests).
 * @param {number} [deps.timeoutMs] - Tiempo máximo antes de forzar la salida.
 * @returns {(signal: string, exitCode?: number) => Promise<void>}
 */
const createShutdown = ({
  server,
  pool,
  stopJobs,
  exit = (code) => process.exit(code),
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
}) => {
  let closing = null;

  return (signal, exitCode = 0) => {
    if (closing) return closing;
    console.warn(`⏹️  ${signal} recibido: cerrando servidor (esperando requests en curso)...`);

    const forceTimer = setTimeout(() => {
      console.error(`🔴  El cierre superó ${timeoutMs} ms: salida forzada.`);
      exit(1);
    }, timeoutMs);
    if (forceTimer.unref) forceTimer.unref();

    closing = (async () => {
      try {
        stopJobs();
        // server.close deja de aceptar conexiones y resuelve cuando terminan
        // las requests en curso; las keep-alive ociosas se cierran ya.
        await new Promise((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          if (server.closeIdleConnections) server.closeIdleConnections();
        });
        await pool.end();
        clearTimeout(forceTimer);
        console.warn('✅  Cierre ordenado completo.');
        exit(exitCode);
      } catch (err) {
        clearTimeout(forceTimer);
        console.error('🔴  Error durante el cierre:', err);
        exit(1);
      }
    })();
    return closing;
  };
};

/**
 * Engancha señales y errores no manejados del proceso al cierre ordenado.
 * @param {Object} deps
 * @param {Function} deps.shutdown - Resultado de createShutdown.
 * @param {NodeJS.Process} [deps.proc]
 */
const registerProcessHandlers = ({ shutdown, proc = process }) => {
  proc.on('SIGTERM', () => shutdown('SIGTERM', 0));
  proc.on('SIGINT', () => shutdown('SIGINT', 0));
  proc.on('unhandledRejection', (reason) => {
    console.error('🔴  Promesa rechazada sin manejar:', reason);
    shutdown('unhandledRejection', 1);
  });
  proc.on('uncaughtException', (err) => {
    console.error('🔴  Excepción no capturada:', err);
    shutdown('uncaughtException', 1);
  });
};

/** Detiene todas las tareas registradas en node-cron. */
const stopCronJobs = () => {
  const cron = require('node-cron');
  for (const task of cron.getTasks().values()) task.stop();
};

/** Programa los cron jobs del sistema. */
const startCronJobs = () => {
  require('../jobs/overdueInstallments.job').start();
  require('../jobs/creditExpiry.job').start();
  require('../jobs/weeklyCommissionCycle.job').start();
  require('../jobs/tokenCleanup.job').start();
  require('../jobs/installmentDueSoon.job').start();
  require('../jobs/cashRegisterReminder.job').start();
};

/**
 * Arranca el servidor HTTP, los cron (fuera de test) y los handlers de cierre.
 * @param {import('express').Express} app
 * @returns {import('http').Server}
 */
const startServer = (app) => {
  const pool = require('../config/db');
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.warn(`🚀  Servidor corriendo en http://localhost:${PORT}`);
    console.warn(`📋  Ambiente: ${process.env.NODE_ENV || 'development'}`);

    // Iniciar cron jobs solo fuera del entorno de tests
    if (process.env.NODE_ENV !== 'test') startCronJobs();
  });

  const shutdown = createShutdown({
    server,
    pool,
    stopJobs: stopCronJobs,
    timeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT_MS || String(DEFAULT_SHUTDOWN_TIMEOUT_MS), 10),
  });
  registerProcessHandlers({ shutdown });
  return server;
};

module.exports = { createShutdown, registerProcessHandlers, startServer, stopCronJobs };
