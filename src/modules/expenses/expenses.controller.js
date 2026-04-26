const service  = require('./expenses.service');
const response = require('../../utils/response');

const getAll = async (req, res) => {
  try {
    const { date_from, date_to, page, limit } = req.query;
    return response.success(res, await service.getAll({ dateFrom: date_from, dateTo: date_to, page, limit }));
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
    const result = await service.create(req.body, req.user);
    return response.created(res, result, 'Gasto registrado correctamente.');
  } catch (err) { return response.serverError(res, err); }
};

const remove = async (req, res) => {
  try {
    await service.remove(req.params.id);
    return response.success(res, null, 'Gasto eliminado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getAll, getById, create, remove };
