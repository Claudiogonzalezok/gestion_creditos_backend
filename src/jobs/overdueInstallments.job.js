// ══════════════════════════════════════════════════════════════════════════════
// Job nocturno de mora con catch-up per-cuota.
// Se ejecuta todos los días a las 02:00 hs (zona horaria del servidor).
//
// MODELO:
//   La fuente de verdad NO es cron_execution_log sino la columna
//   installments.last_penalty_applied_at. Cada cuota sabe hasta qué día se le
//   procesó mora. El cron es un "reconciliador" — no un "ejecutor diario".
//
// FÓRMULA (catch-up de M días en una sola operación):
//   Por cuota:
//     mora_start = GREATEST(
//                    COALESCE(last_penalty_applied_at, due_date + grace_days) + 1,
//                    due_date + grace_days + 1
//                  )
//     M          = effective_today - mora_start + 1
//
//   Si M > 0 — aplicar Fórmula B compuesta cerrada SOBRE saldo ajustado:
//     pending_committed = SUM(payments PENDING no-reversal sobre esta cuota)
//     saldo_0           = amount_due − amount_paid − pending_committed
//     delta_total       = saldo_0 × ((1 + r)^M − 1)
//     penalty_new       = LEAST(penalty + delta_total, original × max_rate)
//     amount_due        = original_amount + penalty_new   ← invariante
//     last_penalty_applied_at = effective_today           ← SOLO si saldo_0 > 0 y M > 0
//
// PRE-CARGAS PENDIENTES (clave):
//   Si una cuota tiene pre-cargas PENDING que cubren su saldo (total o parcial),
//   el cron NO aplica mora sobre la porción ya comprometida. Esto evita que
//   un cliente quede con saldo residual cuando pagó pero el admin no llegó a
//   aprobar antes de las 02:00.
//
//   · Pre-cargas con is_reversal=TRUE NO cuentan (son compensaciones de
//     reversión, no compromisos de pago).
//   · Pre-cargas REJECTED no cuentan (el "compromiso" se rompió).
//   · Si la pre-carga se rechaza después, el cron del día siguiente verá
//     pending_committed=0 y aplicará mora normalmente desde ese día.
//
// PRECISIÓN:
//   Se usa el SALDO ACTUAL para el catch-up retroactivo, no el saldo histórico
//   día por día. Si hubo pagos durante un downtime del cron, el saldo actual
//   es MENOR que durante la ventana → se sub-aplica mora (favorece al cliente).
//   Decisión consciente y documentada — "cliente-friendly" y defensible.
//
// ATOMICIDAD:
//   Todo el cálculo + UPDATE se hace en un único statement SQL con CTE dentro
//   de BEGIN/COMMIT. Si algo falla, ROLLBACK deja la DB intacta y ninguna
//   last_penalty_applied_at se mueve. El próximo run reaplica el catch-up
//   correctamente.
//
// CONGELAMIENTO DE FECHA:
//   effective_today se captura una sola vez al inicio del job y se pasa como
//   parámetro a todas las queries — protege contra cambios de reloj/NTP/TZ
//   durante la ejecución.
//
// PRIMERA CORRIDA:
//   Si nunca corrió antes (cron_execution_log vacío para este job), aplica
//   comportamiento legacy: limitar M a 1 para evitar "big bang" inicial.
// ══════════════════════════════════════════════════════════════════════════════

const cron = require("node-cron");
const pool = require("../config/db");
const { getValue } = require("../modules/systemConfig/systemConfig.queries");
const { runWithLogging, ts } = require("../utils/cronLogger");
const notificationsService = require("../modules/notifications/notifications.service");
const notificationsQueries = require("../modules/notifications/notifications.queries");

/**
 * Hook: notifica a los admins activos sobre las cuotas que entraron/siguen en
 * mora en esta corrida. Se ejecuta DESPUÉS del COMMIT del UPDATE de mora —
 * fuera de la transacción de negocio — y es best-effort: un fallo de notify()
 * nunca debe afectar el resultado ya persistido del job.
 * @param {Array<{id: string, days_applied: number}>} updatedRows
 */
const _notifyOverdueInstallments = async (updatedRows) => {
  if (!updatedRows.length) return;
  try {
    const adminIds = await notificationsQueries.getActiveAdminUserIds();
    const details = await pool.query(
      `SELECT i.id, i.installment_number, c.id AS credit_id, cu.full_name AS customer_name
       FROM installments i
       JOIN credits c    ON c.id  = i.credit_id
       JOIN customers cu ON cu.id = c.customer_id
       WHERE i.id = ANY($1::uuid[])`,
      [updatedRows.map((r) => r.id)],
    );
    for (const row of details.rows) {
      await notificationsService.notify({
        type: "MORA",
        title: "Mora detectada",
        message: `La cuota Nº ${row.installment_number} del cliente "${row.customer_name}" entró en mora.`,
        targetUserIds: adminIds,
        entityType: "credit",
        entityId: row.credit_id,
      });
    }
  } catch (err) {
    console.error(
      `[${ts()}] 🔴  [notifications] Falló el hook de MORA (overdueInstallments):`,
      err,
    );
  }
};

/**
 * Devuelve la fecha de la última corrida exitosa de este job, o null si nunca corrió.
 * Usa finished_at::date — el started_at puede caer en el día anterior si la
 * corrida cruza medianoche.
 */
const getLastSuccessfulRunDate = async (client) => {
  const r = await client.query(
    `SELECT MAX(finished_at::date) AS last_date
     FROM cron_execution_log
     WHERE job_name = 'overdueInstallments' AND success = TRUE`,
  );
  return r.rows[0].last_date || null;
};

const markOverdueAndApplyPenalty = () =>
  runWithLogging("overdueInstallments", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const graceDays = parseInt((await getValue("penalty_grace_days")) || "3");
      const maxRate = parseFloat(
        (await getValue("penalty_max_rate")) || "0.50",
      );
      const dailyRate = parseFloat(
        (await getValue("penalty_rate_daily")) || "0.005",
      );

      // Congelar la fecha de referencia para toda la corrida.
      const todayRes = await client.query("SELECT CURRENT_DATE AS today");
      const effectiveToday = todayRes.rows[0].today;

      // Primera corrida del sistema: limitar M a 1 para evitar big bang inicial.
      const lastRun = await getLastSuccessfulRunDate(client);
      const isFirstRun = lastRun === null;

      // Single UPDATE con CTE — atómico.
      // En to_update filtramos days_to_apply > 0 Y pending_adjusted_balance > 0:
      //   · Cuotas en gracia → days_to_apply <= 0 → FUERA, no mueven last.
      //   · Cuotas con pre-carga PENDING cubriendo saldo total → balance <= 0 →
      //     FUERA, no mueven last (la pre-carga "protege" del cobro de mora).
      //   · Cuotas con pre-carga PARCIAL → balance reducido, mora sobre la
      //     parte aún no comprometida.
      // CRÍTICO: si una cuota cubierta quedara marcada como "procesada hoy",
      // perdería días legítimos de mora si la pre-carga se rechazara después.
      const result = await client.query(
        `WITH params AS (
         SELECT $1::date    AS effective_today,
                $2::int     AS grace_days,
                $3::numeric AS daily_rate,
                $4::numeric AS max_rate,
                $5::bool    AS is_first_run
       ),
       candidates AS (
         SELECT
           i.id,
           i.original_amount,
           i.penalty_amount,
           i.amount_due,
           i.amount_paid,
           i.status,
           p.effective_today,
           p.daily_rate,
           p.max_rate,
           -- Pre-cargas PENDING (no-reversal) que ya están comprometidas sobre
           -- esta cuota. Si suman lo suficiente, la cuota queda "cubierta" y
           -- el cron no le aplica mora.
           COALESCE((
             SELECT SUM(pay.amount_received)
             FROM payments pay
             WHERE pay.installment_id = i.id
               AND pay.status         = 'PENDING'
               AND pay.is_reversal    = FALSE
           ), 0) AS pending_committed,
           GREATEST(
             COALESCE(i.last_penalty_applied_at, i.due_date + p.grace_days) + 1,
             i.due_date + p.grace_days + 1
           ) AS mora_start
         FROM installments i, params p
         WHERE i.status IN ('PENDING','PARTIAL','OVERDUE')
           AND (i.amount_due - i.amount_paid) > 0
           AND i.penalty_amount < i.original_amount * p.max_rate
       ),
       to_update AS (
         SELECT
           c.*,
           (c.amount_due - c.amount_paid - c.pending_committed) AS pending_adjusted_balance,
           CASE
             WHEN (SELECT is_first_run FROM params)
               THEN LEAST(c.effective_today - c.mora_start + 1, 1)
             ELSE       c.effective_today - c.mora_start + 1
           END AS days_to_apply
         FROM candidates c
       )
       UPDATE installments i
       SET
         penalty_amount = LEAST(
           t.penalty_amount + t.pending_adjusted_balance
                              * (POWER(1 + t.daily_rate, t.days_to_apply) - 1),
           t.original_amount * t.max_rate
         ),
         amount_due = t.original_amount + LEAST(
           t.penalty_amount + t.pending_adjusted_balance
                              * (POWER(1 + t.daily_rate, t.days_to_apply) - 1),
           t.original_amount * t.max_rate
         ),
         status = CASE
                    WHEN t.status IN ('PENDING','PARTIAL') THEN 'OVERDUE'
                    ELSE t.status
                  END,
         last_penalty_applied_at = t.effective_today,
         updated_at              = NOW()
       FROM to_update t
       WHERE i.id = t.id
         AND t.days_to_apply             > 0
         AND t.pending_adjusted_balance  > 0
       RETURNING i.id, t.days_to_apply::int AS days_applied`,
        [effectiveToday, graceDays, dailyRate, maxRate, isFirstRun],
      );

      await client.query("COMMIT");

      // Hook MORA: fuera de la transacción, post-commit. Best-effort.
      await _notifyOverdueInstallments(result.rows);

      const updatedCount = result.rows.length;
      const totalDays = result.rows.reduce((sum, r) => sum + r.days_applied, 0);
      console.log(
        `[${ts()}] [JOB overdueInstallments] ` +
          `${updatedCount} cuota(s) actualizada(s) — total ${totalDays} día(s) de mora aplicados ` +
          `(effective_today=${effectiveToday}, last_run=${lastRun || "NUNCA"}).`,
      );

      return {
        affected_rows: updatedCount,
        metadata: {
          effective_today: effectiveToday,
          last_successful_run: lastRun,
          is_first_run: isFirstRun,
          cuotas_updated: updatedCount,
          total_days_applied: totalDays,
        },
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

const start = () => {
  // Todos los días a las 02:00 (zona horaria configurada en TZ o por defecto AR).
  cron.schedule("0 2 * * *", markOverdueAndApplyPenalty, {
    timezone: process.env.TZ || "America/Argentina/Buenos_Aires",
  });
  console.log(
    `[${ts()}] [JOB overdueInstallments] Programado — todos los días a las 02:00.`,
  );
};

module.exports = { start, markOverdueAndApplyPenalty };
