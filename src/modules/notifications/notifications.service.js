const queries = require("./notifications.queries");
const mailer = require("../../utils/mailer");

/**
 * Servicio central de emisión de notificaciones.
 *
 * Flujo:
 *   1. Lee la preferencia del tipo. Si enabled=false → no hace nada (ni push
 *      ni email). Un tipo sin fila se trata como enabled=true (default).
 *   2. Push: inserta una fila en `notifications` por cada userId destino.
 *      Es la fuente de verdad — siempre se persiste si enabled=true.
 *   3. Email: SOLO si email_enabled=true en la preferencia Y el caller pidió
 *      el canal 'email' Y el usuario destino tiene email registrado. El
 *      envío es best-effort: cualquier error se loguea y NUNCA se propaga.
 *
 * IMPORTANTE: este servicio NO conoce transacciones de negocio. El caller es
 * responsable de invocarlo DESPUÉS del COMMIT de su propia operación (o,
 * para jobs cron que ya corren fuera de una transacción de negocio, de forma
 * directa). Esto evita que un fallo de SMTP revierta una operación real.
 *
 * @param {object} params
 * @param {string} params.type - Uno de los 6 tipos soportados.
 * @param {string} params.title
 * @param {string} params.message
 * @param {string[]} params.targetUserIds - IDs de usuarios destino.
 * @param {('push'|'email')[]} [params.channels] - Canales solicitados por el caller.
 * @param {string} [params.entityType] - Para deep-link opcional en el frontend.
 * @param {string} [params.entityId]
 * @param {string} [params.html] - Cuerpo HTML alternativo para el email (si difiere de `message`).
 * @returns {Promise<void>}
 */
const notify = async ({
  type,
  title,
  message,
  targetUserIds,
  channels = ["push"],
  entityType,
  entityId,
  html,
}) => {
  if (!targetUserIds || targetUserIds.length === 0) return;

  const preference = await queries.getPreferenceByType(type);
  // Tipo sin fila de preferencia → default enabled=true, email_enabled=false.
  const enabled = preference ? preference.enabled : true;
  const emailEnabled = preference ? preference.email_enabled : false;

  if (!enabled) return;

  // Push: siempre se persiste (fuente de verdad del historial/badge).
  await Promise.all(
    targetUserIds.map((userId) =>
      queries.insertNotification({
        userId,
        type,
        title,
        message,
        entityType,
        entityId,
      }),
    ),
  );

  // Email: solo si el caller lo pidió Y la preferencia lo habilita.
  const wantsEmail = channels.includes("email") && emailEnabled;
  if (!wantsEmail) return;

  await Promise.all(
    targetUserIds.map(async (userId) => {
      try {
        const email = await queries.getUserEmail(userId);
        if (!email) return; // sin email registrado → solo push, sin error.
        await mailer.sendMail({
          to: email,
          subject: title,
          html: html || `<p>${message}</p>`,
        });
      } catch (err) {
        // Best-effort: el fallo de envío se loguea pero nunca se propaga.
        console.error(
          `🔴  [notifications] Falló el envío de email (tipo=${type}, userId=${userId}):`,
          err,
        );
      }
    }),
  );
};

/**
 * Devuelve las 6 preferencias de notificación.
 * @returns {Promise<object[]>}
 */
const getPreferences = async () => queries.getPreferences();

/**
 * Actualiza la preferencia de un tipo de notificación.
 * @param {string} type
 * @param {object} data
 * @returns {Promise<object>}
 */
const updatePreference = async (type, data) =>
  queries.updatePreference(type, data);

/**
 * Historial paginado de notificaciones de un usuario.
 * @param {string} userId
 * @param {number} page
 * @param {number} limit
 * @returns {Promise<object>}
 */
const listByUser = async (userId, page = 1, limit = 20) =>
  queries.listByUser(userId, page, limit);

/**
 * Cantidad de notificaciones no leídas del usuario.
 * @param {string} userId
 * @returns {Promise<number>}
 */
const countUnread = async (userId) => queries.countUnread(userId);

/**
 * Marca una notificación como leída. Idempotente.
 * @param {string} id
 * @param {string} userId
 * @returns {Promise<void>}
 */
const markRead = async (id, userId) => {
  await queries.markRead(id, userId);
};

/**
 * Marca todas las notificaciones del usuario como leídas.
 * @param {string} userId
 * @returns {Promise<void>}
 */
const markAllRead = async (userId) => {
  await queries.markAllRead(userId);
};

/**
 * Borra una notificación del usuario autenticado.
 * @param {string} id
 * @param {string} userId
 * @returns {Promise<void>}
 */
const deleteById = async (id, userId) => {
  await queries.deleteById(id, userId);
};

/**
 * Borra todas las notificaciones del usuario autenticado.
 * @param {string} userId
 * @returns {Promise<void>}
 */
const deleteAllByUser = async (userId) => {
  await queries.deleteAllByUser(userId);
};

module.exports = {
  notify,
  getPreferences,
  updatePreference,
  listByUser,
  countUnread,
  markRead,
  markAllRead,
  deleteById,
  deleteAllByUser,
};
