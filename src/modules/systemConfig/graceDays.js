// Helper compartido para leer penalty_grace_days. Vive en un archivo propio
// (y no en systemConfig.queries) para que los tests que mockean
// systemConfig.queries con solo getValue sigan funcionando sin cambios.
const systemConfigQueries = require('./systemConfig.queries');

// Default histórico si la clave no está configurada en system_config.
const DEFAULT_GRACE_DAYS = '3';

/**
 * Días de gracia antes de considerar vencida una cuota (penalty_grace_days).
 * @returns {Promise<number>}
 */
const getGraceDays = async () =>
  parseInt((await systemConfigQueries.getValue('penalty_grace_days')) || DEFAULT_GRACE_DAYS);

module.exports = { getGraceDays, DEFAULT_GRACE_DAYS };
