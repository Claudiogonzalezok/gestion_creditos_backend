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

/**
 * Borra las liquidaciones de comisiones de un usuario (E2E de liquidación
 * semanal, evita el conflicto "ya fue liquidado para el período" al
 * re-correr la suite). Ver guarda de habilitación en `test.routes.js`.
 */
const resetCommissionLiquidations = async (req, res) => {
  try {
    const data = await service.resetCommissionLiquidations(req.params.userId);
    return response.success(res, data, "Liquidaciones de comisiones borradas.");
  } catch (err) {
    return response.serverError(res, err);
  }
};

/**
 * Fuerza el `created_at` de un crédito (E2E del cron `creditExpiry`). Ver
 * guarda de habilitación en `test.routes.js`.
 */
const forceCreditCreatedAt = async (req, res) => {
  try {
    const data = await service.forceCreditCreatedAt(req.params.id, req.body.created_at);
    return response.success(res, data, "created_at forzado.");
  } catch (err) {
    if (err.status) return res.status(err.status).json({ ok: false, message: err.message });
    return response.serverError(res, err);
  }
};

module.exports = {
  resetToday,
  forceInstallmentDueDate,
  resetCommissionLiquidations,
  forceCreditCreatedAt,
};
