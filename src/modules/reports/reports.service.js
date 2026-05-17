const queries = require('./reports.queries');

const getCollectionReport = async (dateFrom, dateTo) =>
  queries.getCollectionReport(dateFrom, dateTo);

const getPortfolioReport = () => queries.getPortfolioReport();

const getOverdueReport = () => queries.getOverdueReport();

const getCollectorsReport = async (dateFrom, dateTo) =>
  queries.getCollectorsReport(dateFrom, dateTo);

const getSellersReport = async (dateFrom, dateTo) =>
  queries.getSellersReport(dateFrom, dateTo);

const getProductsReport = (stockThreshold) =>
  queries.getProductsReport(stockThreshold);

const getUpcomingReport = (days) =>
  queries.getUpcomingReport(days);

const getSummaryReport = () => queries.getSummaryReport();

module.exports = {
  getCollectionReport,
  getPortfolioReport,
  getOverdueReport,
  getCollectorsReport,
  getSellersReport,
  getProductsReport,
  getUpcomingReport,
  getSummaryReport,
};
