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

/**
 * Fuerza el `due_date` de una cuota (E2E de mora/cron). Ver guarda de
 * habilitación en `test.routes.js`.
 */
const forceInstallmentDueDate = async (req, res) => {
  try {
    const data = await service.forceInstallmentDueDate(
      req.params.id,
      req.body.due_date,
    );
    return response.success(res, data, "due_date forzado.");
  } catch (err) {
    if (err.status) return res.status(err.status).json({ ok: false, message: err.message });
    return response.serverError(res, err);
  }
};

module.exports = { resetToday, forceInstallmentDueDate };
