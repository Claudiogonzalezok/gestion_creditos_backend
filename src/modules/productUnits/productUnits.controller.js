const service  = require('./productUnits.service');
const response = require('../../utils/response');

const getAll = async (req, res) => {
  try {
    const { variant_id, product_id, status, search } = req.query;
    return response.success(res, await service.getAll({ variantId: variant_id, productId: product_id, status, search }));
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
    const { variant_id, unit_code, notes } = req.body;
    const unit = await service.create({ variantId: variant_id, unitCode: unit_code, notes }, req.user.id);
    return response.created(res, unit, 'Unidad registrada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const createBulk = async (req, res) => {
  try {
    const { variant_id, units } = req.body;
    const result = await service.createBulk(variant_id, units, req.user.id);
    return response.created(res, result, `${result.created} unidad(es) registrada(s) correctamente.`);
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const update = async (req, res) => {
  try {
    const { unit_code, notes } = req.body;
    const unit = await service.update(req.params.id, { unitCode: unit_code, notes });
    return response.success(res, unit, 'Unidad actualizada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const deactivate = async (req, res) => {
  try {
    await service.deactivate(req.params.id, req.user.id);
    return response.success(res, null, 'Unidad dada de baja correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const activate = async (req, res) => {
  try {
    await service.activate(req.params.id);
    return response.success(res, null, 'Unidad reactivada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getAll, getById, create, createBulk, update, deactivate, activate };
