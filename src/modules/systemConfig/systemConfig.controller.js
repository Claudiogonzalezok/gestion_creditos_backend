const service  = require('./systemConfig.service');
const response = require('../../utils/response');

// GET /api/system-config
const getAll = async (req, res) => {
  try {
    return response.success(res, await service.getAll());
  } catch (err) {
    return response.serverError(res, err);
  }
};

// GET /api/system-config/:key
const getByKey = async (req, res) => {
  try {
    return response.success(res, await service.getByKey(req.params.key));
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

// PUT /api/system-config/:key
const update = async (req, res) => {
  try {
    const param = await service.update(req.params.key, req.body.value, req.user.id);
    return response.success(res, param, 'Parámetro actualizado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 400) return response.badRequest(res, err.message);
    return response.serverError(res, err);
  }
};

// POST /api/system-config/:key/reset
const resetToDefault = async (req, res) => {
  try {
    const param = await service.resetToDefault(req.params.key, req.user.id);
    return response.success(res, param, 'Parámetro restaurado al valor por defecto.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getAll, getByKey, update, resetToDefault };
