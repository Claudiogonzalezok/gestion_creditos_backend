const queries = require("./notifications.queries");

/**
 * Servicio central de emisión de notificaciones (push in-app, V1).
 *
 * Flujo:
 *   1. Lee la preferencia del tipo. Si enabled=false → no hace nada. Un tipo
 *      sin fila se trata como enabled=true (default).
 *   2. Inserta una fila en `notifications` por cada userId destino.
 *
 * IMPORTANTE: este servicio NO conoce transacciones de negocio. El caller es
 * responsable de invocarlo DESPUÉS del COMMIT de su propia operación (o,
 * para jobs cron que ya corren fuera de una transacción de negocio, de forma
 * directa).
 *
 * @param {object} params
 * @param {string} params.type - Uno de los tipos soportados.
 * @param {string} params.title
 * @param {string} params.message
 * @param {string[]} params.targetUserIds - IDs de usuarios destino.
 * @param {string} [params.entityType] - Para deep-link opcional en el frontend.
 * @param {string} [params.entityId]
 * @returns {Promise<void>}
 */
const notify = async ({
  type,
  title,
  message,
  targetUserIds,
  entityType,
  entityId,
}) => {
  if (!targetUserIds || targetUserIds.length === 0) return;

  const preference = await queries.getPreferenceByType(type);
  // Tipo sin fila de preferencia → default enabled=true.
  const enabled = preference ? preference.enabled : true;

  if (!enabled) return;

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
};

/**
 * Devuelve las preferencias de notificación.
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
