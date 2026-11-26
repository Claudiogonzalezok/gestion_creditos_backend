const queries = require("./reports.queries");
const { getGraceDays } = require("../systemConfig/graceDays");
const { getValue } = require("../systemConfig/systemConfig.queries");
const {
  getActiveJornadaDate,
} = require("../businessDays/businessDays.service");
const bdQueries = require("../businessDays/businessDays.queries");
const csQueries = require("../cashSessions/cashSessions.queries");

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

/**
 * Reporte de productos. Si no llega umbral, usa low_stock_threshold de
 * system_config (#106).
 * @param {number} [stockThreshold]
 * @returns {Promise<object[]>}
 */
const getProductsReport = async (stockThreshold) => {
  const threshold = stockThreshold !== undefined
    ? stockThreshold
    : Number(await getValue("low_stock_threshold"));
  return queries.getProductsReport(threshold);
};

const getUpcomingReport = (days) => queries.getUpcomingReport(days);

/**
 * Resumen del dashboard. La recaudación se ata a la CAJA ABIERTA de la jornada
 * (misma fuente que el gate de caja del dashboard): mientras la caja esté
 * abierta, se acumula en la fecha de su jornada (no se resetea al cambiar el día
 * calendario); si la caja está cerrada, no hay jornada activa a reportar y la
 * recaudación vuelve a 0 (jornadaDate = null → la query no suma nada).
 * @returns {Promise<object>}
 */
const getSummaryReport = async () => {
  const branch = await bdQueries.findDefaultBranch();
  const day = branch ? await bdQueries.findActiveBusinessDay(branch.id) : null;
  const openSession = day
    ? await csQueries.findActiveSessionByBusinessDay(day.id)
    : null;
  const jornadaDate = openSession ? await getActiveJornadaDate() : null;
  return queries.getSummaryReport(await getGraceDays(), jornadaDate);
};

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
