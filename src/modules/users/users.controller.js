const service  = require('./users.service');
const response = require('../../utils/response');

// GET /api/users
const getAll = async (req, res) => {
  try {
    const { role, roles, status, search } = req.query;
    // `roles` llega como CSV (ej: "COLLECTOR,SELLER_COLLECTOR"); se normaliza a array.
    const rolesArr = roles
      ? String(roles).split(',').map((r) => r.trim()).filter(Boolean)
      : undefined;
    const users = await service.getAll({ role, roles: rolesArr, status, search });
    return response.success(res, users);
  } catch (err) {
    return response.serverError(res, err);
  }
};

// GET /api/users/:id
const getById = async (req, res) => {
  try {
    const user = await service.getById(req.params.id);
    return response.success(res, user);
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

// POST /api/users
const create = async (req, res) => {
  try {
    const { full_name, dni, email, address, role } = req.body;
    const result = await service.create({ full_name, dni, email, address, role });
    return response.created(res, result, 'Usuario creado correctamente. Comunicá la contraseña temporal al usuario.');
  } catch (err) {
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PUT /api/users/:id
const update = async (req, res) => {
  try {
    const { full_name, dni, email, address, role } = req.body;
    const user = await service.update(req.params.id, { full_name, dni, email, address, role });
    return response.success(res, user, 'Usuario actualizado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PATCH /api/users/:id/deactivate
const deactivate = async (req, res) => {
  try {
    await service.deactivate(req.params.id);
    return response.success(res, null, 'Usuario desactivado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PATCH /api/users/:id/activate
const activate = async (req, res) => {
  try {
    await service.activate(req.params.id);
    return response.success(res, null, 'Usuario activado correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PATCH /api/users/:id/reset-password
const resetPassword = async (req, res) => {
  try {
    const result = await service.resetPassword(req.params.id);
    return response.success(res, result, 'Contraseña reseteada. Mostrá la contraseña temporal al usuario ahora; no se podrá recuperar luego.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

// PATCH /api/users/:id/unlock
const unlock = async (req, res) => {
  try {
    await service.unlock(req.params.id);
    return response.success(res, null, 'Cuenta desbloqueada correctamente.');
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// PATCH /api/users/me/change-password
const changePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    await service.changePassword(req.user.id, current_password, new_password);
    return response.success(res, null, 'Contraseña cambiada correctamente.');
  } catch (err) {
    if (err.status === 401) return response.unauthorized(res, err.message);
    if (err.status === 400) return response.badRequest(res, err.message);
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { getAll, getById, create, update, deactivate, activate, resetPassword, unlock, changePassword };
