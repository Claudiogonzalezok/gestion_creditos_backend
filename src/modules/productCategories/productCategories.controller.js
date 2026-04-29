const service  = require('./productCategories.service');
const response = require('../../utils/response');

const getAll = async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    return response.success(res, await service.getAll({ includeInactive }));
  } catch (err) { return response.serverError(res, err); }
};

const create = async (req, res) => {
  try {
    const result = await service.create({ name: req.body.name });
    return response.created(res, result, 'Categoría creada correctamente.');
  } catch (err) {
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const update = async (req, res) => {
  try {
    const result = await service.update(req.params.id, req.body.name);
    return response.success(res, result, 'Categoría actualizada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const activate = async (req, res) => {
  try {
    await service.activate(req.params.id);
    return response.success(res, null, 'Categoría activada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const deactivate = async (req, res) => {
  try {
    await service.deactivate(req.params.id);
    return response.success(res, null, 'Categoría desactivada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getAll, create, update, activate, deactivate };
