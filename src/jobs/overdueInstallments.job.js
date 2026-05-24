// ══════════════════════════════════════════════════════════════════════════════
// Job nocturno de mora.
// Se ejecuta todos los días a las 02:00 hs (zona horaria del servidor).
//
// Responsabilidades:
//   1. Marcar cuotas vencidas (snapshot operativo) PENDING/PARTIAL → OVERDUE
//      cuando due_date + grace_days < CURRENT_DATE.
//   2. Acumular mora diaria sobre las cuotas vencidas con saldo > 0,
//      usando la fórmula oficial (Fórmula B):
//
//          saldo_pendiente_real = (original_amount + penalty_amount) - amount_paid
//          mora_delta_diaria   = saldo_pendiente_real × daily_rate
//          nueva_mora          = LEAST(penalty_amount + mora_delta, cap)
//          cap                 = original_amount × max_rate
//          amount_due          = original_amount + nueva_mora   ← invariante
//
// Notas:
//   · El cron NO es la fuente de verdad de "vencida": la lógica financiera
//     usa una condición derivada (ver IS_OVERDUE_DERIVED). El status OVERDUE
//     queda como snapshot visual/operativo.
//   · El cron aplica un (1) día de mora por corrida, independientemente de
//     cuántos días pasaron desde la última ejecución. La recuperación de mora
//     perdida por caídas del cron es un tema separado (no resuelto en esta
//     etapa).
//   · Las cuotas REFINANCED están excluidas por el filtro de status, lo que
//     evita acumular mora sobre deuda ya absorbida en una refinanciación.
// ══════════════════════════════════════════════════════════════════════════════

const cron = require('node-cron');
const pool = require('../config/db');
const { getValue } = require('../modules/systemConfig/systemConfig.queries');
const { runWithLogging } = require('../utils/cronLogger');

const markOverdueAndApplyPenalty = () => runWithLogging('overdueInstallments', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const graceDays = parseInt(await getValue('penalty_grace_days') || '3');
    const maxRate   = parseFloat(await getValue('penalty_max_rate')  || '0.50');
    const dailyRate = parseFloat(await getValue('penalty_rate_daily')|| '0.005');

    // 1. Snapshot operativo: PENDING/PARTIAL → OVERDUE cuando el vencimiento
    //    superó el período de gracia. REFINANCED/PAID quedan fuera por el filtro.
    const overdueResult = await client.query(
      `UPDATE installments
       SET status = 'OVERDUE', updated_at = NOW()
       WHERE status IN ('PENDING', 'PARTIAL')
         AND due_date < (CURRENT_DATE - $1::int * INTERVAL '1 day')
       RETURNING id`,
      [graceDays]
    );

    // 2. Mora diaria sobre saldo pendiente real (Fórmula B).
    //    Condiciones defensivas (no se confía solo en status='OVERDUE'):
    //      · due_date + grace_days < CURRENT_DATE
    //      · saldo_pendiente_real > 0
    //      · penalty_amount < cap (queda margen antes del tope)
    //
    //    Se usa una CTE para calcular la nueva mora una sola vez y mantener
    //    la invariante amount_due = original_amount + penalty_amount.
    const penaltyResult = await client.query(
      `WITH computed AS (
         SELECT
           id,
           LEAST(
             penalty_amount + ((amount_due - amount_paid) * $1),
             original_amount * $2
           ) AS new_penalty
         FROM installments
         WHERE status = 'OVERDUE'
           AND due_date < (CURRENT_DATE - $3::int * INTERVAL '1 day')
           AND (amount_due - amount_paid) > 0
           AND penalty_amount < (original_amount * $2)
       )
       UPDATE installments i
       SET penalty_amount = c.new_penalty,
           amount_due     = i.original_amount + c.new_penalty,
           updated_at     = NOW()
       FROM computed c
       WHERE i.id = c.id
       RETURNING i.id`,
      [dailyRate, maxRate, graceDays]
    );

    await client.query('COMMIT');

    const markedCount  = overdueResult.rows.length;
    const penaltyCount = penaltyResult.rows.length;
    console.log(
      `[JOB overdueInstallments] Marcadas OVERDUE: ${markedCount} · ` +
      `Mora aplicada: ${penaltyCount} cuota(s).`
    );

    // affected_rows refleja la cantidad de cuotas con mora aplicada (acción
    // financiera principal del job). Las marcadas como OVERDUE quedan en metadata.
    return {
      affected_rows: penaltyCount,
      metadata: { marked_overdue: markedCount, penalty_applied: penaltyCount },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

const start = () => {
  // Todos los días a las 02:00 (zona horaria configurada en TZ o por defecto AR).
  cron.schedule('0 2 * * *', markOverdueAndApplyPenalty, {
    timezone: process.env.TZ || 'America/Argentina/Buenos_Aires',
  });
  console.log('[JOB overdueInstallments] Programado — todos los días a las 02:00.');
};

module.exports = { start, markOverdueAndApplyPenalty };
