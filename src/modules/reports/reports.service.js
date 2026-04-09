const queries = require('./reports.queries');

const getCollectionReport = async (dateFrom, dateTo) => {
  if (!dateFrom || !dateTo)
    throw { status: 400, message: 'Los parámetros date_from y date_to son obligatorios.' };
  if (new Date(dateFrom) > new Date(dateTo))
    throw { status: 400, message: 'date_from no puede ser posterior a date_to.' };
  return queries.getCollectionReport(dateFrom, dateTo);
};

const getPortfolioReport = () => queries.getPortfolioReport();

const getOverdueReport = () => queries.getOverdueReport();

const getCollectorsReport = async (dateFrom, dateTo) => {
  if (!dateFrom || !dateTo)
    throw { status: 400, message: 'Los parámetros date_from y date_to son obligatorios.' };
  return queries.getCollectorsReport(dateFrom, dateTo);
};

const getProductsReport = () => queries.getProductsReport();

module.exports = {
  getCollectionReport, getPortfolioReport, getOverdueReport,
  getCollectorsReport, getProductsReport,
};
