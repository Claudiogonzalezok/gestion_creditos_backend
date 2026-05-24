// Marca cuotas vencidas y aplica mora automáticamente
// Se ejecuta todos los días a las 02:00 hs.

const cron = require('node-cron');
const pool = require('../config/db');
const { getValue } = require('../modules/systemConfig/systemConfig.queries');

const markOverdueAndApplyPenalty = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const graceDays  = parseInt(await getValue('penalty_grace_days') || '3');
    const maxRate    = parseFloat(await getValue('penalty_max_rate')  || '0.50');
    const dailyRate  = parseFloat(await getValue('penalty_rate_daily')|| '0.005');

    // 1. Pasar PENDING/PARTIAL → OVERDUE cuando la fecha venció + días de gracia.
    //    Solo sobre créditos ACTIVE: excluye REFINANCED, SETTLED y EXPIRED.
    const overdueResult = await client.query(
      `UPDATE installments i
       SET status = 'OVERDUE', updated_at = NOW()
       FROM credits c
       WHERE i.credit_id = c.id
         AND c.status = 'ACTIVE'
         AND i.status IN ('PENDING', 'PARTIAL')
         AND i.due_date < (CURRENT_DATE - $1 * INTERVAL '1 day')
       RETURNING i.id, i.amount_due, i.penalty_amount`,
      [graceDays]
    );

    // 2. Aplicar mora diaria a todas las cuotas ya OVERDUE.
    //    Solo sobre créditos ACTIVE: misma restricción que el paso 1.
    await client.query(
      `UPDATE installments i
       SET penalty_amount = LEAST(
             i.penalty_amount + ((i.amount_due - i.penalty_amount) * $1),
             (i.amount_due - i.penalty_amount) * $2
           ),
           amount_due = i.amount_due + LEAST(
             (i.amount_due - i.penalty_amount) * $1,
             GREATEST((i.amount_due - i.penalty_amount) * $2 - i.penalty_amount, 0)
           ),
           updated_at = NOW()
       FROM credits c
       WHERE i.credit_id = c.id
         AND c.status = 'ACTIVE'
         AND i.status = 'OVERDUE'
         AND i.penalty_amount < (i.amount_due - i.penalty_amount) * $2`,
      [dailyRate, maxRate]
    );

    await client.query('COMMIT');

    const count = overdueResult.rows.length;
    if (count > 0)
      console.log(`[JOB overdueInstallments] ${count} cuota(s) pasaron a OVERDUE (PENDING + PARTIAL).`);
    else
      console.log('[JOB overdueInstallments] Sin nuevas cuotas vencidas.');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[JOB overdueInstallments] Error:', err.message);
  } finally {
    client.release();
  }
};

const start = () => {
  // Todos los días a las 02:00
  cron.schedule('0 2 * * *', markOverdueAndApplyPenalty, {
    timezone: process.env.TZ || 'America/Argentina/Buenos_Aires',
  });
  console.log('[JOB overdueInstallments] Programado — todos los días a las 02:00.');
};

module.exports = { start, markOverdueAndApplyPenalty };
