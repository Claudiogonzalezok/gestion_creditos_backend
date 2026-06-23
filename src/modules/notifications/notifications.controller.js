const service = require("./notifications.service");
const response = require("../../utils/response");

const getPreferences = async (req, res) => {
  try {
    return response.success(res, await service.getPreferences());
  } catch (err) {
    return response.serverError(res, err);
  }
};

const updatePreference = async (req, res) => {
  try {
    const updated = await service.updatePreference(req.params.type, {
      enabled: req.body.enabled,
      email_enabled: req.body.email_enabled,
      frequency: req.body.frequency,
    });
    return response.success(
      res,
      updated,
      "Preferencia actualizada correctamente.",
    );
  } catch (err) {
    return response.serverError(res, err);
  }
};

const listByUser = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = await service.listByUser(req.user.id, page, limit);
    return response.success(res, result);
  } catch (err) {
    return response.serverError(res, err);
  }
};

const unreadCount = async (req, res) => {
  try {
    const count = await service.countUnread(req.user.id);
    return response.success(res, { count });
  } catch (err) {
    return response.serverError(res, err);
  }
};

const markRead = async (req, res) => {
  try {
    await service.markRead(req.params.id, req.user.id);
    return response.success(res, null, "Notificación marcada como leída.");
  } catch (err) {
    return response.serverError(res, err);
  }
};

const markAllRead = async (req, res) => {
  try {
    await service.markAllRead(req.user.id);
    return response.success(
      res,
      null,
      "Todas las notificaciones fueron marcadas como leídas.",
    );
  } catch (err) {
    return response.serverError(res, err);
  }
};

const deleteById = async (req, res) => {
  try {
    await service.deleteById(req.params.id, req.user.id);
    return response.success(res, null, "Notificación borrada correctamente.");
  } catch (err) {
    return response.serverError(res, err);
  }
};

const deleteAllByUser = async (req, res) => {
  try {
    await service.deleteAllByUser(req.user.id);
    return response.success(res, null, "Notificaciones borradas correctamente.");
  } catch (err) {
    return response.serverError(res, err);
  }
};

module.exports = {
  getPreferences,
  updatePreference,
  listByUser,
  unreadCount,
  markRead,
  markAllRead,
  deleteById,
  deleteAllByUser,
};
