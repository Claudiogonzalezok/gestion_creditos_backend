// Expira créditos en PENDING_APPROVAL que llevan más días que el parámetro configurado
// Se ejecuta todos los días a las 03:00 hs.

const cron = require('node-cron');
const pool = require('../config/db');
const { getValue } = require('../modules/systemConfig/systemConfig.queries');

const expireOldCredits = async () => {
  const client = await pool.connect();
  try {
    const days = parseInt(await getValue('credit_expiry_days') || '7');

    await client.query('BEGIN');

    const r = await client.query(
      `UPDATE credits
       SET status = 'EXPIRED', updated_at = NOW()
       WHERE status = 'PENDING_APPROVAL'
         AND created_at < NOW() - ($1 || ' days')::INTERVAL
       RETURNING id`,
      [days]
    );

    const expiredIds = r.rows.map((row) => row.id);

    if (expiredIds.length) {
      // Liberar unidades RESERVED vinculadas a créditos expirados
      const freed = await client.query(
        `UPDATE product_units
         SET status = 'AVAILABLE', updated_at = NOW()
         WHERE status = 'RESERVED'
           AND id IN (
             SELECT product_unit_id
             FROM credit_products
             WHERE credit_id = ANY($1::uuid[])
           )
         RETURNING id`,
        [expiredIds]
      );
      console.log(
        `[JOB creditExpiry] ${expiredIds.length} crédito(s) expirado(s). ` +
        `${freed.rows.length} unidad(es) liberada(s).`
      );
    } else {
      console.log('[JOB creditExpiry] Sin créditos a expirar.');
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[JOB creditExpiry] Error:', err.message);
  } finally {
    client.release();
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
