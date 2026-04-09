// Expira créditos en PENDING_APPROVAL que llevan más días que el parámetro configurado
// Se ejecuta todos los días a las 03:00 hs.

const cron = require('node-cron');
const pool = require('../config/db');
const { getValue } = require('../modules/systemConfig/systemConfig.queries');

const expireOldCredits = async () => {
  try {
    const days = parseInt(await getValue('credit_expiry_days') || '7');

    const r = await pool.query(
      `UPDATE credits
       SET status = 'EXPIRED', updated_at = NOW()
       WHERE status = 'PENDING_APPROVAL'
         AND created_at < NOW() - ($1 || ' days')::INTERVAL
       RETURNING id`,
      [days]
    );

    const count = r.rows.length;
    if (count > 0)
      console.log(`[JOB creditExpiry] ${count} crédito(s) expirado(s).`);
    else
      console.log('[JOB creditExpiry] Sin créditos a expirar.');
  } catch (err) {
    console.error('[JOB creditExpiry] Error:', err.message);
  }
};

const start = () => {
  // Todos los días a las 03:00
  cron.schedule('0 3 * * *', expireOldCredits, {
    timezone: process.env.TZ || 'America/Argentina/Buenos_Aires',
  });
  console.log('[JOB creditExpiry] Programado — todos los días a las 03:00.');
};

module.exports = { start, expireOldCredits };
