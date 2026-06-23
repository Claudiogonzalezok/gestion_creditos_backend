// ══════════════════════════════════════════════════════════════════════════════
// Job semanal: informe resumen de operaciones por email.
// Reusa reports.service.getSummaryReport() y envía el resultado a los admins
// activos exclusivamente por email (no genera push — el tipo WEEKLY_REPORT
// está pensado como un email, según el diseño).
// ══════════════════════════════════════════════════════════════════════════════

const cron = require("node-cron");
const { runWithLogging } = require("../utils/cronLogger");
const reportsService = require("../modules/reports/reports.service");
const notificationsService = require("../modules/notifications/notifications.service");
const notificationsQueries = require("../modules/notifications/notifications.queries");

/**
 * Construye el resumen en texto plano (para el historial push) y el HTML
 * (para el cuerpo del email) a partir del resultado de getSummaryReport().
 * Template inline en español, sin librerías de templating extra (alcance V1
 * fijo de 6 tipos).
 * @param {object} summary - Resultado de reports.service.getSummaryReport().
 * @returns {{ plainText: string, html: string }}
 */
const buildSummaryContent = (summary) => ({
  plainText:
    "Informe semanal de operaciones disponible. Revisá tu casilla de correo para el detalle completo.",
  html: `
    <h2>Informe semanal — finFlow</h2>
    <pre>${JSON.stringify(summary, null, 2)}</pre>
  `,
});

const sendWeeklyReportEmail = () =>
  runWithLogging("weeklyReportEmail", async () => {
    const summary = await reportsService.getSummaryReport();
    const adminIds = await notificationsQueries.getActiveAdminUserIds();
    const { plainText, html } = buildSummaryContent(summary);

    await notificationsService.notify({
      type: "WEEKLY_REPORT",
      title: "Informe semanal de operaciones",
      message: plainText,
      html,
      targetUserIds: adminIds,
      channels: ["email"],
    });

    console.log(
      `[JOB weeklyReportEmail] Informe enviado a ${adminIds.length} admin(s).`,
    );
    return { affected_rows: adminIds.length };
  });

const start = () => {
  // Lunes a las 08:00 — inicio de la semana comercial, según diseño.
  cron.schedule("0 8 * * 1", sendWeeklyReportEmail, {
    timezone: process.env.TZ || "America/Argentina/Buenos_Aires",
  });
  console.log("[JOB weeklyReportEmail] Programado — lunes a las 08:00.");
};

module.exports = { start, sendWeeklyReportEmail };
