const queries = require('./reports.queries');

const getCollectionReport = async (dateFrom, dateTo) =>
  queries.getCollectionReport(dateFrom, dateTo);

const getPortfolioReport = () => queries.getPortfolioReport();

const getOverdueReport = () => queries.getOverdueReport();

const getCollectorsReport = async (dateFrom, dateTo) =>
  queries.getCollectorsReport(dateFrom, dateTo);

const getProductsReport = () => queries.getProductsReport();

module.exports = {
  getCollectionReport, getPortfolioReport, getOverdueReport,
  getCollectorsReport, getProductsReport,
};
