const service  = require('./collections.service');
const response = require('../../utils/response');

const generate = async (req, res) => {
  try {
    const result = await service.generate(req.body, req.user.id);
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

module.exports = { generate, getAll, getById };
