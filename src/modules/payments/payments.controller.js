const service  = require('./payments.service');
const { parsePagination, sendList } = require('../../utils/pagination');
const response = require('../../utils/response');

const getAll = async (req, res) => {
  try {
    const { status, collector_id, installment_id, date_from, date_to, created_from, created_to } = req.query;
    const pagination = parsePagination(req.query);
    return sendList(res, await service.getAll({ status, collector_id, installment_id, date_from, date_to, created_from, created_to, pagination }, req.user));
  } catch (err) { return response.serverError(res, err); }
};

const getById = async (req, res) => {
  try {
    return response.success(res, await service.getById(req.params.id, req.user));
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

const create = async (req, res) => {
  try {
    const result = await service.create(req.body, req.user);
    // P08: reintento con el mismo client_request_id → 200 con la pre-carga existente.
    if (result.idempotent_replay)
      return response.success(res, result, 'Pre-carga ya registrada (reintento idempotente).');
    return response.created(res, result, 'Pre-carga registrada correctamente. Pendiente de aprobación.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message, null, err.code || null);
    if (err.status === 422) return response.unprocessableEntity(res, err.message);
    return response.serverError(res, err);
  }
};

const approve = async (req, res) => {
  try {
    const result = await service.approve(req.params.id, req.user.id);
    return response.success(res, result, 'Cobro aprobado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const reject = async (req, res) => {
  try {
    await service.reject(req.params.id, req.body.rejection_reason, req.user.id);
    return response.success(res, null, 'Cobro rechazado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const adminDirect = async (req, res) => {
  try {
    const result = await service.adminDirect(req.body, req.user.id);
    // #73: reintento con el mismo client_request_id → 200 con el cobro existente.
    if (result.idempotent_replay)
      return response.success(res, result, 'Cobro ya registrado (reintento idempotente).');
    return response.created(res, result, 'Cobro registrado y aprobado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message, null, err.code || null);
    if (err.status === 422) return response.unprocessableEntity(res, err.message);
    return response.serverError(res, err);
  }
};

const reverse = async (req, res) => {
  try {
    const result = await service.reverse(req.params.id, req.body.reason, req.user.id);
    return response.success(res, result, 'Cobro revertido correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const getByCredit = async (req, res) => {
  try {
    return response.success(res, await service.getByCredit(req.params.creditId, req.user));
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getAll, getById, create, approve, reject, adminDirect, reverse, getByCredit };
