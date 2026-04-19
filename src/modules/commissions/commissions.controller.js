const service  = require('./commissions.service');
const response = require('../../utils/response');

const getCommissions = async (req, res) => {
  try {
    const { user_id, status, week_start } = req.query;
    return response.success(res, await service.getCommissions({ userId: user_id, status, weekStart: week_start }, req.user));
  } catch (err) { return response.serverError(res, err); }
};

const getWeeklySummary = async (req, res) => {
  try {
    return response.success(res, await service.getWeeklySummary());
  } catch (err) { return response.serverError(res, err); }
};

const liquidate = async (req, res) => {
  try {
    const result = await service.liquidate(req.body, req.user.id);
    return response.created(res, result, 'Liquidación ejecutada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const getLiquidations = async (req, res) => {
  try {
    const { user_id } = req.query;
    return response.success(res, await service.getLiquidations({ userId: user_id }, req.user));
  } catch (err) { return response.serverError(res, err); }
};

const getSalary = async (req, res) => {
  try {
    return response.success(res, await service.getSalary(req.params.userId));
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

const setSalary = async (req, res) => {
  try {
    const result = await service.setSalary(req.params.userId, req.body.weekly_amount);
    return response.success(res, result, 'Sueldo actualizado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getCommissions, getWeeklySummary, liquidate, getLiquidations, getSalary, setSalary };
