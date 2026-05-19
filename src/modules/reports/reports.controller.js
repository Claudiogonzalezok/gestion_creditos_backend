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

const getSellersReport = async (req, res) => {
  try {
    return response.success(res, await service.getSellersReport(req.query.date_from, req.query.date_to));
  } catch (err) {
    if (err.status === 400) return response.badRequest(res, err.message);
    return response.serverError(res, err);
  }
};

const getProductsReport = async (req, res) => {
  try {
    const threshold = req.query.stock_threshold !== undefined
      ? parseInt(req.query.stock_threshold)
      : 5;
    return response.success(res, await service.getProductsReport(threshold));
  } catch (err) { return response.serverError(res, err); }
};

const getUpcomingReport = async (req, res) => {
  try {
    const days = req.query.days !== undefined ? parseInt(req.query.days) : 30;
    return response.success(res, await service.getUpcomingReport(days));
  } catch (err) { return response.serverError(res, err); }
};

const getSummaryReport = async (req, res) => {
  try {
    return response.success(res, await service.getSummaryReport());
  } catch (err) { return response.serverError(res, err); }
};

const getPaymentsOverdue48h = async (req, res) => {
  try {
    return response.success(res, await service.getPaymentsOverdue48h());
  } catch (err) { return response.serverError(res, err); }
};

module.exports = {
  getCollectionReport,
  getPortfolioReport,
  getOverdueReport,
  getCollectorsReport,
  getSellersReport,
  getProductsReport,
  getUpcomingReport,
  getSummaryReport,
  getPaymentsOverdue48h,
};
