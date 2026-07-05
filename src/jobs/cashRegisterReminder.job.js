// ══════════════════════════════════════════════════════════════════════════════
// Job diario: recordatorio de cierre de caja.
// Busca business_days con status OPEN a la hora configurada y notifica
// (push, best-effort) a los admins activos para que cierren la jornada.
// ══════════════════════════════════════════════════════════════════════════════

const cron = require("node-cron");
const pool = require("../config/db");
const { runWithLogging } = require("../utils/cronLogger");
const notificationsService = require("../modules/notifications/notifications.service");
const notificationsQueries = require("../modules/notifications/notifications.queries");

const checkOpenCashRegisters = () =>
  runWithLogging("cashRegisterReminder", async () => {
    const result = await pool.query(
      `SELECT id, business_date, branch_id FROM business_days WHERE status = 'OPEN'`,
    );

    if (result.rows.length === 0) {
      console.log("[JOB cashRegisterReminder] Sin jornadas abiertas.");
      return { affected_rows: 0 };
    }

    const adminIds = await notificationsQueries.getActiveAdminUserIds();

    for (const row of result.rows) {
      await notificationsService.notify({
        type: "CASH_REGISTER",
        title: "Recordatorio de cierre de caja",
        message: `La jornada del ${row.business_date} sigue abierta. Recordá cerrar la caja al finalizar el día.`,
        targetUserIds: adminIds,
        entityType: "business_day",
        entityId: row.id,
      });
    }

    console.log(
      `[JOB cashRegisterReminder] ${result.rows.length} jornada(s) notificada(s).`,
    );
    return { affected_rows: result.rows.length };
  });

const start = () => {
  // Todos los días a las 21:00 — fin de la jornada comercial habitual,
  // recordatorio para cerrar caja antes de medianoche.
  cron.schedule("0 21 * * *", checkOpenCashRegisters, {
    timezone: process.env.TZ || "America/Argentina/Buenos_Aires",
  });
  console.log(
    "[JOB cashRegisterReminder] Programado — todos los días a las 21:00.",
  );
};

module.exports = { start, checkOpenCashRegisters };
