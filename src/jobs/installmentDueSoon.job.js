// ══════════════════════════════════════════════════════════════════════════════
// Job diario: recordatorio de cuotas a vencer en 3 días.
// Busca installments con due_date = hoy+3 y status PENDING/PARTIAL, y notifica
// (push + email best-effort) a los admins activos por cada cuota encontrada.
//
// No modifica ningún registro de negocio — es puramente informativo. Por eso
// no necesita transacción ni cron_execution_log de filas afectadas más allá
// del conteo de notificaciones generadas.
// ══════════════════════════════════════════════════════════════════════════════

const cron = require("node-cron");
const pool = require("../config/db");
const { runWithLogging } = require("../utils/cronLogger");
const notificationsService = require("../modules/notifications/notifications.service");
const notificationsQueries = require("../modules/notifications/notifications.queries");

const checkInstallmentsDueSoon = () =>
  runWithLogging("installmentDueSoon", async () => {
    const result = await pool.query(
      `SELECT i.id, i.installment_number, i.due_date,
            c.id AS credit_id, cu.full_name AS customer_name
     FROM installments i
     JOIN credits c    ON c.id  = i.credit_id
     JOIN customers cu ON cu.id = c.customer_id
     WHERE i.due_date = CURRENT_DATE + INTERVAL '3 days'
       AND i.status IN ('PENDING','PARTIAL')`,
    );

    if (result.rows.length === 0) {
      console.log("[JOB installmentDueSoon] Sin cuotas a vencer en 3 días.");
      return { affected_rows: 0 };
    }

    const adminIds = await notificationsQueries.getActiveAdminUserIds();

    for (const row of result.rows) {
      await notificationsService.notify({
        type: "INSTALLMENT_DUE",
        title: "Cuota próxima a vencer",
        message: `La cuota Nº ${row.installment_number} del cliente "${row.customer_name}" vence el ${row.due_date}.`,
        targetUserIds: adminIds,
        channels: ["push", "email"],
        entityType: "credit",
        entityId: row.credit_id,
      });
    }

    console.log(
      `[JOB installmentDueSoon] ${result.rows.length} cuota(s) notificada(s).`,
    );
    return { affected_rows: result.rows.length };
  });

const start = () => {
  // Todos los días a las 08:00 — antes del horario laboral, para que el
  // admin tenga el recordatorio disponible al empezar la jornada.
  cron.schedule("0 8 * * *", checkInstallmentsDueSoon, {
    timezone: process.env.TZ || "America/Argentina/Buenos_Aires",
  });
  console.log(
    "[JOB installmentDueSoon] Programado — todos los días a las 08:00.",
  );
};

module.exports = { start, checkInstallmentsDueSoon };
