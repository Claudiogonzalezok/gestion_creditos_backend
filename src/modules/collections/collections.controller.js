const service  = require('./collections.service');
const response = require('../../utils/response');

const generate = async (req, res) => {
  try {
    const result = await service.generate(req.body, req.user.id);
    if (result.skipped) {
      // skip_if_exists detectó planilla ACTIVE existente: 200 (no 201) y data
      // con { skipped, existing_sheet } para que el frontend lo distinga.
      return res.status(200).json({
        ok: true,
        message: 'Ya existía una planilla activa: se omitió la generación.',
        data: result,
      });
    }
    return res.status(201).json({ ok: true, message: 'Planilla de cobro generada correctamente.', data: result });
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const getAll = async (req, res) => {
  try {
    const { collector_id, date, include_regenerated } = req.query;
    const includeRegenerated = include_regenerated === 'true';
    return response.success(
      res,
      await service.getAll({ collectorId: collector_id, date, includeRegenerated }, req.user),
    );
  } catch (err) { return response.serverError(res, err); }
};

const getById = async (req, res) => {
  try {
    return response.success(res, await service.getById(req.params.id, req.user));
  } catch (err) {
    if (err.status === 403) return response.forbidden(res, err.message);
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

const close = async (req, res) => {
  try {
    const result = await service.close(req.params.id, req.user.id);
    return response.success(res, result, 'Planilla cerrada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const cancel = async (req, res) => {
  try {
    const result = await service.cancel(req.params.id);
    return response.success(res, result, 'Planilla cancelada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { generate, getAll, getById, close, cancel };
