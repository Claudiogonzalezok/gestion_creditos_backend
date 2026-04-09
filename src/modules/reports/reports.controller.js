const service  = require('./reports.service');
const response = require('../../utils/response');

const getCollectionReport = async (req, res) => {
  try {
    return response.success(res, await service.getCollectionReport(req.query.date_from, req.query.date_to));
  } catch (err) {
    if (err.status === 400) return response.badRequest(res, err.message);
    return response.serverError(res, err);
  }
};

const getPortfolioReport = async (req, res) => {
  try {
    return response.success(res, await service.getPortfolioReport());
  } catch (err) { return response.serverError(res, err); }
};

const getOverdueReport = async (req, res) => {
  try {
    return response.success(res, await service.getOverdueReport());
  } catch (err) { return response.serverError(res, err); }
};

const getCollectorsReport = async (req, res) => {
  try {
    return response.success(res, await service.getCollectorsReport(req.query.date_from, req.query.date_to));
  } catch (err) {
    if (err.status === 400) return response.badRequest(res, err.message);
    return response.serverError(res, err);
  }
};

const getProductsReport = async (req, res) => {
  try {
    return response.success(res, await service.getProductsReport());
  } catch (err) { return response.serverError(res, err); }
};

module.exports = {
  getCollectionReport, getPortfolioReport, getOverdueReport,
  getCollectorsReport, getProductsReport,
};
