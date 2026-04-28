const service  = require('./products.service');
const response = require('../../utils/response');

const getAll = async (req, res) => {
  try {
    const { status, search, category_id } = req.query;
    return response.success(res, await service.getAll({ status, search, categoryId: category_id }));
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
    const { description, current_price, category_id } = req.body;
    const product = await service.create({ description, current_price, category_id });
    return response.created(res, product, 'Producto registrado correctamente.');
  } catch (err) {
    if (err.status === 409) return response.conflict(res, err.message);
    if (err.status === 422) return response.unprocessableEntity(res, err.message);
    return response.serverError(res, err);
  }
};

const update = async (req, res) => {
  try {
    const { description, current_price, category_id } = req.body;
    const product = await service.update(req.params.id, { description, current_price, category_id });
    return response.success(res, product, 'Producto actualizado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    if (err.status === 422) return response.unprocessableEntity(res, err.message);
    return response.serverError(res, err);
  }
};

const deactivate = async (req, res) => {
  try {
    await service.deactivate(req.params.id);
    return response.success(res, null, 'Producto desactivado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const activate = async (req, res) => {
  try {
    await service.activate(req.params.id);
    return response.success(res, null, 'Producto activado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getAll, getById, create, update, deactivate, activate };
