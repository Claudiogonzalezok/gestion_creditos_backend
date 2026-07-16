const pool = require("../../config/db");

const NOTIFICATION_TYPES = [
  "MORA",
  "INSTALLMENT_DUE",
  "APPROVAL_REQUEST",
  "CASH_REGISTER",
  "NEW_CUSTOMER",
];

/**
 * Devuelve las filas de preferencias de notificación (config global V1).
 * @returns {Promise<object[]>}
 */
const getPreferences = async () => {
  const r = await pool.query(
    `SELECT type, enabled, frequency, updated_at
     FROM notification_preferences
     WHERE type = ANY($1::text[])
     ORDER BY array_position($1::text[], type) ASC`,
    [NOTIFICATION_TYPES],
  );
  return r.rows;
};

/**
 * Devuelve la preferencia de un tipo puntual, o null si no existe fila
 * (el caller debe asumir el default enabled=true, frequency='INSTANT').
 * @param {string} type
 * @returns {Promise<object|null>}
 */
const getPreferenceByType = async (type) => {
  const r = await pool.query(
    `SELECT type, enabled, frequency, updated_at
     FROM notification_preferences
     WHERE type = $1`,
    [type],
  );
  return r.rows[0] || null;
};

/**
 * Actualiza (upsert) la preferencia de un tipo de notificación.
 * @param {string} type
 * @param {{enabled?: boolean, frequency?: string}} data
 * @returns {Promise<object>} fila actualizada
 */
const updatePreference = async (type, { enabled, frequency }) => {
  const r = await updatePreferenceWithClient(pool, type, { enabled, frequency });
  return r;
};

/**
 * Actualiza una preferencia usando el cliente recibido.
 * Preserva updated_at cuando los valores enviados no cambian el estado actual.
 * @param {object} client - Pool o cliente transaccional con query().
 * @param {string} type
 * @param {{enabled?: boolean, frequency?: string}} data
 * @returns {Promise<object>} fila actualizada
 */
const updatePreferenceWithClient = async (client, type, { enabled, frequency }) => {
  const r = await client.query(
    `INSERT INTO notification_preferences (type, enabled, frequency)
     VALUES ($1, COALESCE($2, TRUE), COALESCE($3, 'INSTANT'))
     ON CONFLICT (type) DO UPDATE SET
        enabled    = COALESCE($2, notification_preferences.enabled),
        frequency  = COALESCE($3, notification_preferences.frequency),
        updated_at = CASE
          WHEN notification_preferences.enabled IS DISTINCT FROM COALESCE($2, notification_preferences.enabled)
            OR notification_preferences.frequency IS DISTINCT FROM COALESCE($3, notification_preferences.frequency)
          THEN NOW()
          ELSE notification_preferences.updated_at
        END
     RETURNING type, enabled, frequency, updated_at`,
    [type, enabled, frequency],
  );
  return r.rows[0];
};

/**
 * Inserta una notificación (push) para un usuario destino.
 * @param {object} data
 * @param {string} data.userId
 * @param {string} data.type
 * @param {string} data.title
 * @param {string} data.message
 * @param {string} [data.entityType]
 * @param {string} [data.entityId]
 * @returns {Promise<object>} fila insertada
 */
const insertNotification = async ({
  userId,
  type,
  title,
  message,
  entityType,
  entityId,
}) => {
  const r = await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, type, title, message, read_at, entity_type, entity_id, created_at`,
    [userId, type, title, message, entityType || null, entityId || null],
  );
  return r.rows[0];
};

/**
 * Lista paginada del historial de notificaciones de un usuario, más reciente primero.
 * @param {string} userId
 * @param {number} page - 1-indexed
 * @param {number} limit
 * @returns {Promise<{items: object[], total: number, page: number, limit: number}>}
 */
const listByUser = async (userId, page = 1, limit = 20) => {
  const offset = (page - 1) * limit;
  const [itemsRes, countRes] = await Promise.all([
    pool.query(
      `SELECT id, type, title, message, read_at, entity_type, entity_id, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM notifications WHERE user_id = $1`,
      [userId],
    ),
  ]);
  return {
    items: itemsRes.rows,
    total: countRes.rows[0].total,
    page,
    limit,
  };
};

/**
 * Cuenta las notificaciones no leídas (read_at NULL) de un usuario.
 * @param {string} userId
 * @returns {Promise<number>}
 */
const countUnread = async (userId) => {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return r.rows[0].count;
};

/**
 * Marca una notificación como leída (idempotente — no falla si ya estaba leída).
 * @param {string} id
 * @param {string} userId - Asegura que solo el dueño pueda marcarla.
 * @returns {Promise<boolean>} true si la fila existe y pertenece al usuario
 */
const markRead = async (id, userId) => {
  const r = await pool.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [id, userId],
  );
  return r.rowCount > 0;
};

/**
 * Marca todas las notificaciones no leídas de un usuario como leídas.
 * @param {string} userId
 * @returns {Promise<number>} cantidad de filas afectadas
 */
const markAllRead = async (userId) => {
  const r = await pool.query(
    `UPDATE notifications SET read_at = NOW()
     WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return r.rowCount;
};

/**
 * Borra una notificación del historial del usuario autenticado.
 * @param {string} id
 * @param {string} userId - Asegura que solo el dueño pueda borrarla.
 * @returns {Promise<boolean>} true si la fila existía y pertenecía al usuario
 */
const deleteById = async (id, userId) => {
  const r = await pool.query(
    `DELETE FROM notifications
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [id, userId],
  );
  return r.rowCount > 0;
};

/**
 * Borra todas las notificaciones del usuario autenticado.
 * @param {string} userId
 * @returns {Promise<number>} cantidad de filas borradas
 */
const deleteAllByUser = async (userId) => {
  const r = await pool.query(
    `DELETE FROM notifications
     WHERE user_id = $1`,
    [userId],
  );
  return r.rowCount;
};

/**
 * Devuelve los IDs de usuarios ADMIN activos — destinatarios por defecto de
 * las notificaciones operativas en V1 (preferencias globales, no por usuario).
 * @returns {Promise<string[]>}
 */
const getActiveAdminUserIds = async () => {
  const r = await pool.query(
    `SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'`,
  );
  return r.rows.map((row) => row.id);
};

module.exports = {
  NOTIFICATION_TYPES,
  getPreferences,
  getPreferenceByType,
  updatePreference,
  updatePreferenceWithClient,
  insertNotification,
  listByUser,
  countUnread,
  markRead,
  markAllRead,
  deleteById,
  deleteAllByUser,
  getActiveAdminUserIds,
};
