const service  = require('./customers.service');
const response = require('../../utils/response');

// GET /api/customers
const getAll = async (req, res) => {
  try {
    const { status, search, collector_id } = req.query;
    const customers = await service.getAll({ status, search, collector_id });
    return response.success(res, customers);
  } catch (err) {
    return response.serverError(res, err);
  }
};

// GET /api/customers/:id
const getById = async (req, res) => {
  try {
    const customer = await service.getById(req.params.id);
    return response.success(res, customer);
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

// POST /api/customers
const create = async (req, res) => {
  try {
    const { full_name, dni, address, phone, email, assigned_collector_id } = req.body;
    const customer = await service.create({ full_name, dni, address, phone, email, assigned_collector_id });
    return response.created(res, customer, 'Cliente registrado correctamente.');
  } catch (err) {
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PUT /api/customers/:id
const update = async (req, res) => {
  try {
    const { full_name, address, phone, email, assigned_collector_id } = req.body;
    const customer = await service.update(req.params.id, { full_name, address, phone, email, assigned_collector_id });
    return response.success(res, customer, 'Cliente actualizado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PATCH /api/customers/:id/deactivate
const deactivate = async (req, res) => {
  try {
    await service.deactivate(req.params.id);
    return response.success(res, null, 'Cliente desactivado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PATCH /api/customers/:id/activate
const activate = async (req, res) => {
  try {
    await service.activate(req.params.id);
    return response.success(res, null, 'Cliente activado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PATCH /api/customers/:id/enable-portal
const enablePortal = async (req, res) => {
  try {
    const result = await service.enablePortal(req.params.id);
    return response.success(res, result, 'Acceso al portal habilitado. Comunicá la contraseña temporal al cliente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PATCH /api/customers/:id/disable-portal
const disablePortal = async (req, res) => {
  try {
    await service.disablePortal(req.params.id);
    return response.success(res, null, 'Acceso al portal deshabilitado.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PATCH /api/customers/:id/reset-portal-password
const resetPortalPassword = async (req, res) => {
  try {
    const result = await service.resetPortalPassword(req.params.id);
    return response.success(res, result, 'Contraseña del portal reseteada. Comunicá la contraseña temporal al cliente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PATCH /api/customers/:id/unlock-portal
const unlockPortal = async (req, res) => {
  try {
    await service.unlockPortal(req.params.id);
    return response.success(res, null, 'Cuenta del portal desbloqueada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = {
  getAll, getById, create, update, deactivate, activate,
  enablePortal, disablePortal, resetPortalPassword, unlockPortal,
};
