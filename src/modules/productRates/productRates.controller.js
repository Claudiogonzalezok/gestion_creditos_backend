const service  = require('./productRates.service');
const response = require('../../utils/response');

const getAll = async (req, res) => {
  try {
    return response.success(res, await service.getAll(req.query.product_id));
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
    return response.created(res, await service.create(req.body), 'Tasa de producto creada.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const update = async (req, res) => {
  try {
    return response.success(res, await service.update(req.params.id, req.body), 'Tasa de producto actualizada.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

const deactivate = async (req, res) => {
  try {
    return response.success(res, await service.deactivate(req.params.id), 'Tasa de producto desactivada.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const activate = async (req, res) => {
  try {
    return response.success(res, await service.activate(req.params.id), 'Tasa de producto activada.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getAll, getById, create, update, deactivate, activate };
