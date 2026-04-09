const service  = require('./interestRates.service');
const response = require('../../utils/response');

const getAll = async (req, res) => {
  try {
    const { credit_type, payment_frequency, active } = req.query;
    const activeFilter = active !== undefined ? active === 'true' : undefined;
    return response.success(res, await service.getAll({ credit_type, payment_frequency, active: activeFilter }));
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

const create = async (req, res) => {
  try {
    const { credit_type, payment_frequency, installments_count, rate } = req.body;
    const result = await service.create({ credit_type, payment_frequency, installments_count, rate });
    return response.created(res, result, 'Tasa registrada correctamente.');
  } catch (err) {
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const update = async (req, res) => {
  try {
    const { rate, active } = req.body;
    return response.success(res, await service.update(req.params.id, { rate, active }), 'Tasa actualizada.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

const deactivate = async (req, res) => {
  try {
    await service.deactivate(req.params.id);
    return response.success(res, null, 'Tasa desactivada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const activate = async (req, res) => {
  try {
    await service.activate(req.params.id);
    return response.success(res, null, 'Tasa activada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getAll, getById, create, update, deactivate, activate };
