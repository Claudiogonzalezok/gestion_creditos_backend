const service  = require('./credits.service');
const response = require('../../utils/response');
const irQueries = require('../interestRates/interestRates.queries');

const getAll = async (req, res) => {
  try {
    const { status, type, customer_id } = req.query;
    return response.success(res, await service.getAll({ status, type, customer_id }, req.user));
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
    const { customer_id, type, total_amount, installments_count, payment_frequency,
             unit_ids, notes,
             down_payment, down_payment_method, down_payment_transfer_reference } = req.body;
    const credit = await service.create({
      customer_id, type, total_amount, installments_count, payment_frequency,
      unit_ids, notes,
      down_payment, down_payment_method, down_payment_transfer_reference,
    }, req.user);
    return response.created(res, credit, 'Pre-operación registrada. Pendiente de aprobación.');
  } catch (err) {
    if (err.status === 400) return response.badRequest(res, err.message);
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const getSimulateOptions = async (req, res) => {
  try {
    const options = await irQueries.findActiveInstallmentOptions();
    return response.success(res, options);
  } catch (err) { return response.serverError(res, err); }
};

const simulate = async (req, res) => {
  try {
    const { type, total_amount, installments_count, payment_frequency, products, down_payment } = req.body;
    return response.success(res, await service.simulate({ type, total_amount, installments_count, payment_frequency, products, down_payment }), 'Simulación calculada.');
  } catch (err) {
    if (err.status === 400) return response.badRequest(res, err.message);
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const approve = async (req, res) => {
  try {
    const credit = await service.approve(req.params.id, req.user.id, req.body.installments_count);
    return response.success(res, credit, 'Crédito aprobado. Cuotas generadas correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const reject = async (req, res) => {
  try {
    await service.reject(req.params.id, req.body.rejection_reason, req.user.id);
    return response.success(res, null, 'Crédito rechazado.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const earlySettlement = async (req, res) => {
  try {
    const { payment_method, transfer_reference } = req.body;
    const result = await service.earlySettlement(req.params.id, payment_method, transfer_reference, req.user.id);
    return response.success(res, result, 'Cancelación anticipada procesada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getAll, getById, create, getSimulateOptions, simulate, approve, reject, earlySettlement };
