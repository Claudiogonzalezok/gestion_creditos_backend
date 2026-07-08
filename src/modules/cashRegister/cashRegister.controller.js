const service = require("./cashRegister.service");
const response = require("../../utils/response");

const getDashboard = async (req, res) => {
  try {
    return response.success(
      res,
      await service.getDashboard(req.query.date || null),
    );
  } catch (err) {
    return response.serverError(res, err);
  }
};

const getPreClose = async (req, res) => {
  try {
    return response.success(
      res,
      await service.getPreClose(req.query.date || null),
    );
  } catch (err) {
    return response.serverError(res, err);
  }
};

const close = async (req, res) => {
  try {
    const result = await service.close(req.body, req.user.id);
    return response.created(
      res,
      result,
      "Cierre de caja registrado correctamente.",
    );
  } catch (err) {
    if (err.status === 409)
      return response.conflict(res, err.message, err.pending_payments ?? null);
    if (err.status === 422)
      return response.unprocessableEntity(res, err.message);
    if (err.status === 400) return response.badRequest(res, err.message);
    return response.serverError(res, err);
  }
};

const getAll = async (req, res) => {
  try {
    const { date_from, date_to, difference_status } = req.query;
    return response.success(
      res,
      await service.getAll({
        dateFrom: date_from,
        dateTo: date_to,
        differenceStatus: difference_status,
      }),
    );
  } catch (err) {
    return response.serverError(res, err);
  }
};

const getById = async (req, res) => {
  try {
    return response.success(res, await service.getById(req.params.id));
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

const getSessionMovements = async (req, res) => {
  try {
    return response.success(
      res,
      await service.getSessionMovements(req.params.cash_session_id),
    );
  } catch (err) {
    return response.serverError(res, err);
  }
};

const createConversion = async (req, res) => {
  try {
    const result = await service.createConversion(req.body, req.user.id);
    return response.created(
      res,
      result,
      "Conversión de caja registrada correctamente.",
    );
  } catch (err) {
    if (err.status === 409) return response.conflict(res, err.message);
    if (err.status === 422)
      return response.unprocessableEntity(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = {
  getDashboard,
  getPreClose,
  close,
  getAll,
  getById,
  createConversion,
  getSessionMovements,
};
