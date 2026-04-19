const service  = require('./productRates.service');
const response = require('../../utils/response');

const getAll = async (req, res, next) => {
  try {
    const data = await service.getAll(req.query.product_id);
    response.success(res, data, 'Tasas de producto obtenidas.');
  } catch (e) { next(e); }
};

const getById = async (req, res, next) => {
  try {
    const data = await service.getById(req.params.id);
    response.success(res, data, 'Tasa de producto obtenida.');
  } catch (e) { next(e); }
};

const create = async (req, res, next) => {
  try {
    const data = await service.create(req.body);
    response.created(res, data, 'Tasa de producto creada.');
  } catch (e) { next(e); }
};

const update = async (req, res, next) => {
  try {
    const data = await service.update(req.params.id, req.body);
    response.success(res, data, 'Tasa de producto actualizada.');
  } catch (e) { next(e); }
};

const deactivate = async (req, res, next) => {
  try {
    const data = await service.deactivate(req.params.id);
    response.success(res, data, 'Tasa de producto desactivada.');
  } catch (e) { next(e); }
};

const activate = async (req, res, next) => {
  try {
    const data = await service.activate(req.params.id);
    response.success(res, data, 'Tasa de producto activada.');
  } catch (e) { next(e); }
};

module.exports = { getAll, getById, create, update, deactivate, activate };
