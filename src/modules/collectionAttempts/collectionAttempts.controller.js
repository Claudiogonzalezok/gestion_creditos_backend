const service  = require('./collectionAttempts.service');
const response = require('../../utils/response');

const create = async (req, res) => {
  try {
    const result = await service.create(req.body, req.user);
    return response.created(res, result, 'Intento de cobranza registrado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 403) return response.forbidden(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    if (err.status === 422) return response.unprocessableEntity(res, err.message);
    return response.serverError(res, err);
  }
};

const getAll = async (req, res) => {
  try {
    const { collector_id, installment_id } = req.query;
    return response.success(res, await service.getAll({ collectorId: collector_id, installmentId: installment_id }, req.user));
  } catch (err) { return response.serverError(res, err); }
};

const getById = async (req, res) => {
  try {
    return response.success(res, await service.getById(req.params.id, req.user));
  } catch (err) {
    if (err.status === 403) return response.forbidden(res, err.message);
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { create, getAll, getById };
