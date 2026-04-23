const service  = require('./cashRegister.service');
const response = require('../../utils/response');

const getDashboard = async (req, res) => {
  try {
    return response.success(res, await service.getDashboard());
  } catch (err) { return response.serverError(res, err); }
};

const close = async (req, res) => {
  try {
    const result = await service.close(req.body, req.user.id);
    return response.created(res, result, 'Cierre de caja registrado correctamente.');
  } catch (err) {
    if (err.status === 409) {
      const body = { ok: false, message: err.message };
      if (err.pending_payments) body.pending_payments = err.pending_payments;
      return res.status(409).json(body);
    }
    return response.serverError(res, err);
  }
};

const getAll = async (req, res) => {
  try {
    const { date_from, date_to, difference_status } = req.query;
    return response.success(res, await service.getAll({ dateFrom: date_from, dateTo: date_to, differenceStatus: difference_status }));
  } catch (err) { return response.serverError(res, err); }
};

const getById = async (req, res) => {
  try {
    return response.success(res, await service.getById(req.params.id));
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getDashboard, close, getAll, getById };
