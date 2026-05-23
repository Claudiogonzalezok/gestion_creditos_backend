const service  = require('./productVariants.service');
const response = require('../../utils/response');

const getAll = async (req, res) => {
  try {
    const { product_id, status } = req.query;
    return response.success(res, await service.getAll({ productId: product_id, status }));
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
    const { product_id, color, size, capacity, current_price, initial_units } = req.body;
    const variant = await service.create({ product_id, color, size, capacity, current_price, initial_units });
    return response.created(res, variant, 'Variante registrada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

/**
 * Crea múltiples variantes en un solo request y devuelve errores por fila.
 */
const createBulk = async (req, res) => {
  try {
    const { product_id, rows } = req.body;
    const result = await service.createBulk({ product_id, rows });
    return response.created(res, result, 'Variantes registradas correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message, err.data || null);
    if (err.status === 400) return response.badRequest(res, err.message, err.errors || null);
    return response.serverError(res, err);
  }
};

const update = async (req, res) => {
  try {
    const { color, size, capacity, current_price } = req.body;
    const variant = await service.update(req.params.id, { color, size, capacity, current_price });
    return response.success(res, variant, 'Variante actualizada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

const deactivate = async (req, res) => {
  try {
    await service.deactivate(req.params.id);
    return response.success(res, null, 'Variante desactivada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const activate = async (req, res) => {
  try {
    await service.activate(req.params.id);
    return response.success(res, null, 'Variante activada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getAll, getById, create, createBulk, update, deactivate, activate };
