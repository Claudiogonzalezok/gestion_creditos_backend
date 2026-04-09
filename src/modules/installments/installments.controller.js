const service  = require('./installments.service');
const response = require('../../utils/response');

const getAll = async (req, res) => {
  try {
    const { credit_id, status } = req.query;
    return response.success(res, await service.getAll({ credit_id, status }, req.user));
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

const applyPenalty = async (req, res) => {
  try {
    const result = await service.applyPenalty(req.params.id, req.body.penalty_amount);
    return response.success(res, result, 'Mora aplicada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const waivePenalty = async (req, res) => {
  try {
    const result = await service.waivePenalty(req.params.id);
    return response.success(res, result, 'Mora condonada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getAll, getById, applyPenalty, waivePenalty };
