const service  = require('./products.service');
const response = require('../../utils/response');

// GET /api/products
const getAll = async (req, res) => {
  try {
    const { status, search } = req.query;
    const products = await service.getAll({ status, search });
    return response.success(res, products);
  } catch (err) {
    return response.serverError(res, err);
  }
};

// GET /api/products/:id
const getById = async (req, res) => {
  try {
    const product = await service.getById(req.params.id);
    return response.success(res, product);
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

// POST /api/products
const create = async (req, res) => {
  try {
    const { name, description, current_price, available_stock } = req.body;
    const product = await service.create({ name, description, current_price, available_stock });
    return response.created(res, product, 'Producto registrado correctamente.');
  } catch (err) {
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PUT /api/products/:id
const update = async (req, res) => {
  try {
    const { name, description, current_price } = req.body;
    const product = await service.update(req.params.id, { name, description, current_price });
    return response.success(res, product, 'Producto actualizado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PATCH /api/products/:id/stock
const adjustStock = async (req, res) => {
  try {
    const { quantity, movement, reason } = req.body;
    const product = await service.adjustStock(req.params.id, quantity, movement, reason, req.user.id);
    const label = movement === 'IN' ? 'Entrada de stock' : 'Salida de stock';
    return response.success(res, product, `${label} registrada correctamente.`);
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PATCH /api/products/:id/deactivate
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

// PATCH /api/products/:id/activate
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

module.exports = { getAll, getById, create, update, adjustStock, deactivate, activate };
