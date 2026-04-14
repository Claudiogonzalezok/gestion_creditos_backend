const service  = require('./portal.service');
const response = require('../../utils/response');

const getAccountSummary = async (req, res) => {
  try {
    return response.success(res, await service.getAccountSummary(req.customer.id));
  } catch (err) {
    return response.serverError(res, err);
  }
};

const getCredits = async (req, res) => {
  try {
    return response.success(res, await service.getCredits(req.customer.id));
  } catch (err) {
    return response.serverError(res, err);
  }
};

const getCreditById = async (req, res) => {
  try {
    return response.success(res, await service.getCreditById(req.params.id, req.customer.id));
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getAccountSummary, getCredits, getCreditById };
