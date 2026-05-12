const service = require("./holidays.service");
const response = require("../../utils/response");

/**
 * Lista feriados aplicando filtros simples de consulta.
 * @param {import('express').Request} req - Request HTTP.
 * @param {import('express').Response} res - Response HTTP.
 * @returns {Promise<import('express').Response>} Respuesta API estandarizada.
 */
const getAll = async (req, res) => {
  try {
    const { type, active, affects_due_dates } = req.query;
    const activeFilter = active !== undefined ? active === "true" : undefined;
    const affectsFilter =
      affects_due_dates !== undefined
        ? affects_due_dates === "true"
        : undefined;
    const data = await service.getAll({
      type,
      active: activeFilter,
      affects_due_dates: affectsFilter,
    });
    return response.success(res, data);
  } catch (err) {
    return response.serverError(res, err);
  }
};

/**
 * Recupera el detalle de un feriado por ID.
 * @param {import('express').Request} req - Request HTTP.
 * @param {import('express').Response} res - Response HTTP.
 * @returns {Promise<import('express').Response>} Respuesta API estandarizada.
 */
const getById = async (req, res) => {
  try {
    return response.success(res, await service.getById(req.params.id));
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

/**
 * Crea un feriado y opcionalmente dispara recálculo controlado de cuotas futuras.
 * @param {import('express').Request} req - Request HTTP.
 * @param {import('express').Response} res - Response HTTP.
 * @returns {Promise<import('express').Response>} Respuesta API estandarizada.
 */
const create = async (req, res) => {
  try {
    const result = await service.create(req.body);
    return response.created(res, result, "Feriado registrado correctamente.");
  } catch (err) {
    if (err.code === "23505")
      return response.conflict(
        res,
        "Ya existe un feriado para esa fecha y tipo.",
      );
    return response.serverError(res, err);
  }
};

/**
 * Actualiza campos editables de un feriado existente.
 * @param {import('express').Request} req - Request HTTP.
 * @param {import('express').Response} res - Response HTTP.
 * @returns {Promise<import('express').Response>} Respuesta API estandarizada.
 */
const update = async (req, res) => {
  try {
    return response.success(
      res,
      await service.update(req.params.id, req.body),
      "Feriado actualizado.",
    );
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

/**
 * Genera vista previa de duplicación anual sin persistir cambios.
 * @param {import('express').Request} req - Request HTTP.
 * @param {import('express').Response} res - Response HTTP.
 * @returns {Promise<import('express').Response>} Respuesta API estandarizada.
 */
const previewDuplicateYear = async (req, res) => {
  try {
    const { sourceYear } = req.body;
    const result = await service.previewDuplicateYear(sourceYear);
    return response.success(res, result, "Vista previa de duplicación generada.");
  } catch (err) {
    return response.serverError(res, err);
  }
};

/**
 * Duplica feriados elegibles desde un año origen al año siguiente.
 * @param {import('express').Request} req - Request HTTP.
 * @param {import('express').Response} res - Response HTTP.
 * @returns {Promise<import('express').Response>} Respuesta API estandarizada.
 */
const duplicateYear = async (req, res) => {
  try {
    const { sourceYear } = req.body;
    const result = await service.duplicateYear(sourceYear);
    return response.success(
      res,
      result,
      "Duplicación anual de feriados completada.",
    );
  } catch (err) {
    return response.serverError(res, err);
  }
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  previewDuplicateYear,
  duplicateYear,
};
