const service = require("./test.service");
const response = require("../../utils/response");

/**
 * Limpia la jornada de hoy (business_day + cash_sessions + dependientes) de
 * la sucursal default. Idempotente: si no hay jornada hoy, no hace nada.
 */
const resetToday = async (req, res) => {
  try {
    const data = await service.resetToday();
    return response.success(res, data, "Jornada de hoy reseteada.");
  } catch (err) {
    return response.serverError(res, err);
  }
};

module.exports = { resetToday };
