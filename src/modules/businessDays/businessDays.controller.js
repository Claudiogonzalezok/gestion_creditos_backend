const service  = require('./businessDays.service');
const response = require('../../utils/response');

const handleError = (res, err) => {
  if (err.status === 404) return response.notFound(res, err.message);
  if (err.status === 409) return response.conflict(res, err.message);
  if (err.status === 422) return res.status(422).json({ ok: false, message: err.message });
  return response.serverError(res, err);
};

const getById = async (req, res) => {
  try { return response.success(res, await service.getById(req.params.id)); }
  catch (err) { return handleError(res, err); }
};

const getAll = async (req, res) => {
  try {
    return response.success(res, await service.getAll({
      status:    req.query.status,
      branchId:  req.query.branch_id,
      dateFrom:  req.query.date_from,
      dateTo:    req.query.date_to,
    }));
  } catch (err) { return handleError(res, err); }
};

const close = async (req, res) => {
  try {
    const data = await service.close(req.params.id, req.body, req.user);
    return res.status(200).json({ ok: true, message: 'Jornada cerrada.', data });
  } catch (err) { return handleError(res, err); }
};

const forceClose = async (req, res) => {
  try {
    const data = await service.forceClose(req.params.id, req.body, req.user);
    return res.status(200).json({ ok: true, message: 'Jornada cerrada (force).', data });
  } catch (err) { return handleError(res, err); }
};

const audit = async (req, res) => {
  try {
    const data = await service.audit(req.params.id, req.body, req.user);
    return res.status(200).json({ ok: true, message: 'Jornada auditada.', data });
  } catch (err) { return handleError(res, err); }
};

module.exports = { getById, getAll, close, forceClose, audit };
