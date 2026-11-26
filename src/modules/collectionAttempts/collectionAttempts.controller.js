const service  = require('./collectionAttempts.service');
const { parsePagination, sendList } = require('../../utils/pagination');
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
    const pagination = parsePagination(req.query);
    return sendList(res, await service.getAll({ collectorId: collector_id, installmentId: installment_id, pagination }, req.user));
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

const voidAttempt = async (req, res) => {
  try {
    const result = await service.voidAttempt(req.params.id, req.user);
    return response.success(res, result, 'Intento de cobranza anulado.');
  } catch (err) {
    if (err.status === 403) return response.forbidden(res, err.message);
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { create, getAll, getById, voidAttempt };
