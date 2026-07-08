// Cierra el ciclo semanal de comisiones todos los sábados a las 23:59.
// No modifica el estado de las comisiones — estas se liquidan el lunes por el Admin.
// Solo registra un log de cierre y notifica cuántas comisiones PENDING quedaron.

const cron = require('node-cron');
const pool = require('../config/db');
const { getWeekBounds } = require('../utils/creditCalculator');
const { getValue } = require('../modules/systemConfig/systemConfig.queries');
const { runWithLogging, ts } = require('../utils/cronLogger');

const closeWeeklyCycle = () => runWithLogging('weeklyCommissionCycle', async () => {
  // Leer el parámetro en cada ejecución para reflejar cambios del Admin sin reinicio
  const closeDay = parseInt(await getValue('commission_week_close_day') || '6');
  if (new Date().getDay() !== closeDay) {
    return { affected_rows: 0, metadata: { skipped: 'not_close_day' } };
  }

  const { week_start, week_end } = getWeekBounds(new Date());

  const r = await pool.query(
    `SELECT
       u.full_name,
       COALESCE(SUM(cm.amount), 0)::float8 AS pending_total,
       COUNT(cm.id)::int AS pending_count
     FROM commissions cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.status = 'PENDING'
       AND cm.week_start = $1
       AND cm.week_end   = $2
     GROUP BY u.full_name
     ORDER BY u.full_name`,
    [week_start, week_end]
  );

  if (r.rows.length === 0) {
    console.log(`[${ts()}] [JOB weeklyCommissionCycle] Ciclo ${week_start}→${week_end}: sin comisiones pendientes.`);
    return { affected_rows: 0, metadata: { week_start, week_end, employees: 0 } };
  }

  const totalEgress = r.rows.reduce((sum, row) => sum + parseFloat(row.pending_total), 0);
  const totalCount  = r.rows.reduce((sum, row) => sum + parseInt(row.pending_count), 0);
  console.log(`[${ts()}] [JOB weeklyCommissionCycle] Ciclo ${week_start}→${week_end} cerrado.`);
  console.log(`  Empleados con pendientes: ${r.rows.length}`);
  console.log(`  Total a liquidar el lunes: $${totalEgress.toFixed(2)}`);
  r.rows.forEach(row =>
    console.log(`  - ${row.full_name}: $${parseFloat(row.pending_total).toFixed(2)} (${row.pending_count} comisiones)`)
  );

  return {
    affected_rows: totalCount,
    metadata: {
      week_start, week_end,
      employees: r.rows.length,
      total_pending: totalEgress,
    },
  };
});

const start = () => {
  // Corre todos los días a las 23:59; el día de cierre se evalúa dinámicamente
  // dentro de closeWeeklyCycle leyendo commission_week_close_day desde system_config.
  cron.schedule('59 23 * * *', closeWeeklyCycle, {
    timezone: process.env.TZ || 'America/Argentina/Buenos_Aires',
  });
  console.log(`[${ts()}] [JOB weeklyCommissionCycle] Programado — todos los días a las 23:59.`);
};

module.exports = { start, closeWeeklyCycle };
