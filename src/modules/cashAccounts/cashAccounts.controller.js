const service  = require('./cashAccounts.service');
const response = require('../../utils/response');

const handleError = (res, err) => {
  if (err.status === 404) return response.notFound(res, err.message);
  if (err.status === 409) {
    const body = { ok: false, message: err.message };
    if (err.code) body.code = err.code;
    return res.status(409).json(body);
  }
  if (err.status === 422) {
    const body = { ok: false, message: err.message };
    if (err.code) body.code = err.code;
    return res.status(422).json(body);
  }
  return response.serverError(res, err);
};

const getAll = async (req, res) => {
  try { return response.success(res, await service.getAll()); }
  catch (err) { return handleError(res, err); }
};

const getById = async (req, res) => {
  try { return response.success(res, await service.getById(req.params.id)); }
  catch (err) { return handleError(res, err); }
};

const getBalance = async (req, res) => {
  try { return response.success(res, await service.getBalance(req.params.id)); }
  catch (err) { return handleError(res, err); }
};

const getAuditBalance = async (req, res) => {
  try { return response.success(res, await service.getAuditBalance(req.params.id)); }
  catch (err) { return handleError(res, err); }
};

const listMovements = async (req, res) => {
  try {
    const data = await service.listMovements(req.params.id, {
      movementType: req.query.movement_type,
      direction:    req.query.direction,
      from:         req.query.from,
      to:           req.query.to,
      page:         req.query.page,
      pageSize:     req.query.page_size,
    });
    return response.success(res, data);
  } catch (err) { return handleError(res, err); }
};

const registerMovement = async (req, res) => {
  try {
    const data = await service.registerMovement(req.params.id, {
      movementType:     req.body.movement_type,
      direction:        req.body.direction,
      amount:           req.body.amount,
      description:      req.body.description,
      beneficiaryName:  req.body.beneficiary_name,
    }, req.user);
    return res.status(201).json({ ok: true, message: 'Movimiento registrado.', data });
  } catch (err) { return handleError(res, err); }
};

module.exports = {
  getAll, getById, getBalance, getAuditBalance, listMovements, registerMovement,
};
