const queries = require('./company.queries');
const systemConfigQueries = require('../systemConfig/systemConfig.queries');
const systemConfigService = require('../systemConfig/systemConfig.service');

/**
 * Mapa campo de API → clave de system_config para las tasas de la empresa.
 * Mora, comisión y gracia son las mismas claves que usa la lógica de negocio:
 * cambiarlas acá cambia el comportamiento real del sistema.
 */
const RATE_KEYS = {
  sale_rate_monthly:      'company_sale_rate_monthly',
  loan_rate_monthly:      'company_loan_rate_monthly',
  mora_rate_daily:        'penalty_rate_daily',
  seller_commission_rate: 'commission_rate',
  grace_period_days:      'penalty_grace_days',
};

/**
 * Lee las tasas de la empresa desde system_config.
 * @returns {Promise<object>} { sale_rate_monthly, ..., grace_period_days } numéricos
 */
const getRates = async () => {
  const rates = {};
  for (const [field, key] of Object.entries(RATE_KEYS)) {
    const value = await systemConfigQueries.getValue(key);
    rates[field] = value === null ? null : Number(value);
  }
  return rates;
};

/**
 * Umbral de stock bajo desde system_config (#106).
 * @returns {Promise<number>}
 */
const getLowStockThreshold = async () =>
  Number(await systemConfigQueries.getValue('low_stock_threshold'));

/**
 * Datos de la empresa + tasas + umbral de stock bajo.
 * @returns {Promise<{company: object, rates: object, low_stock_threshold: number}>}
 */
const get = async () => {
  const company = await queries.getSettings();
  return { company, rates: await getRates(), low_stock_threshold: await getLowStockThreshold() };
};

/**
 * Actualiza los datos de contacto de la empresa y/o el umbral de stock bajo (parcial).
 * @param {object} data - campos de company_settings y low_stock_threshold opcional
 * @param {string} userId
 * @returns {Promise<{company: object, rates: object, low_stock_threshold: number}>}
 */
const updateCompany = async (data, userId) => {
  const { low_stock_threshold: threshold, ...companyData } = data;
  if (threshold !== undefined)
    await systemConfigService.updateMany({ low_stock_threshold: threshold }, userId);
  const hasCompanyFields = Object.values(companyData).some((v) => v !== undefined);
  const company = hasCompanyFields
    ? await queries.updateSettings(companyData, userId)
    : await queries.getSettings();
  return { company, rates: await getRates(), low_stock_threshold: await getLowStockThreshold() };
};

/**
 * Actualiza las tasas de la empresa (parcial y atómico: si una es inválida
 * no se guarda ninguna).
 * @param {object} data - campos de RATE_KEYS
 * @param {string} userId
 * @returns {Promise<{company: object, rates: object}>}
 */
const updateRates = async (data, userId) => {
  const entries = {};
  for (const [field, key] of Object.entries(RATE_KEYS)) {
    if (data[field] !== undefined) entries[key] = data[field];
  }
  if (Object.keys(entries).length === 0)
    throw { status: 400, message: 'Debe enviar al menos una tasa a actualizar.' };
  await systemConfigService.updateMany(entries, userId);
  return get();
};

module.exports = { get, updateCompany, updateRates, getLowStockThreshold, RATE_KEYS };
