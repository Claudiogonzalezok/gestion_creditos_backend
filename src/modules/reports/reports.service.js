const queries = require("./reports.queries");
const { getValue } = require("../systemConfig/systemConfig.queries");
const {
  getActiveJornadaDate,
} = require("../businessDays/businessDays.service");

/**
 * Devuelve los días de gracia para considerar una cuota vencida en queries
 * que usan la condición derivada (IS_OVERDUE_DERIVED).
 * @returns {Promise<number>}
 */
const getGraceDays = async () =>
  parseInt((await getValue("penalty_grace_days")) || "3");

const getCollectionReport = async (dateFrom, dateTo) =>
  queries.getCollectionReport(dateFrom, dateTo);

const getPortfolioReport = async () =>
  queries.getPortfolioReport(await getGraceDays());

const getOverdueReport = async () =>
  queries.getOverdueReport(await getGraceDays());

const getCollectorsReport = async (dateFrom, dateTo) =>
  queries.getCollectorsReport(dateFrom, dateTo);

const getSellersReport = async (dateFrom, dateTo) =>
  queries.getSellersReport(dateFrom, dateTo);

const getProductsReport = (stockThreshold) =>
  queries.getProductsReport(stockThreshold);

const getUpcomingReport = (days) => queries.getUpcomingReport(days);

const getSummaryReport = async () =>
  queries.getSummaryReport(await getGraceDays(), await getActiveJornadaDate());

const getPaymentsOverdue48h = () => queries.getPaymentsOverdue48h();

const getCashConversionsReport = async (dateFrom, dateTo) =>
  queries.getCashConversionsReport(dateFrom, dateTo);

const getCashMovementsReport = async (cashSessionId) =>
  queries.getCashMovementsReport(cashSessionId);

const getGeneralCashMovementsReport = async (dateFrom, dateTo) =>
  queries.getGeneralCashMovementsReport(dateFrom, dateTo);

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
  getCashConversionsReport,
  getCashMovementsReport,
  getGeneralCashMovementsReport,
};
