// Cierra el ciclo semanal de comisiones todos los sábados a las 23:59.
// No modifica el estado de las comisiones — estas se liquidan el lunes por el Admin.
// Solo registra un log de cierre y notifica cuántas comisiones PENDING quedaron.

const cron = require('node-cron');
const pool = require('../config/db');
const { getWeekBounds } = require('../utils/creditCalculator');

const closeWeeklyCycle = async () => {
  try {
    const { week_start, week_end } = getWeekBounds(new Date());

    const r = await pool.query(
      `SELECT
         u.full_name,
         COALESCE(SUM(cm.amount), 0)::numeric AS pending_total,
         COUNT(cm.id) AS pending_count
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
      console.log(`[JOB weeklyCommissionCycle] Ciclo ${week_start}→${week_end}: sin comisiones pendientes.`);
      return;
    }

    const totalEgress = r.rows.reduce((sum, row) => sum + parseFloat(row.pending_total), 0);
    console.log(`[JOB weeklyCommissionCycle] Ciclo ${week_start}→${week_end} cerrado.`);
    console.log(`  Empleados con pendientes: ${r.rows.length}`);
    console.log(`  Total a liquidar el lunes: $${totalEgress.toFixed(2)}`);
    r.rows.forEach(row =>
      console.log(`  - ${row.full_name}: $${parseFloat(row.pending_total).toFixed(2)} (${row.pending_count} comisiones)`)
    );
  } catch (err) {
    console.error('[JOB weeklyCommissionCycle] Error:', err.message);
  }
};

const start = () => {
  // Sábados a las 23:59
  cron.schedule('59 23 * * 6', closeWeeklyCycle, {
    timezone: process.env.TZ || 'America/Argentina/Buenos_Aires',
  });
  console.log('[JOB weeklyCommissionCycle] Programado — sábados a las 23:59.');
};

module.exports = { start, closeWeeklyCycle };
