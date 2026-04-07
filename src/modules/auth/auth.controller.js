const service  = require('./auth.service');
const response = require('../../utils/response');
const jwtUtil  = require('../../utils/jwt');

// POST /api/auth/login
const loginInternal = async (req, res) => {
  try {
    const { dni, password } = req.body;
    const result = await service.loginInternal(dni, password);
    return response.success(res, result, 'Inicio de sesión exitoso.');
  } catch (err) {
    if (err.status) return res.status(err.status).json({ ok: false, message: err.message });
    return response.serverError(res, err);
  }
};

// POST /api/auth/portal/login
const loginPortal = async (req, res) => {
  try {
    const { dni, password } = req.body;
    const result = await service.loginPortal(dni, password);
    return response.success(res, result, 'Inicio de sesión exitoso.');
  } catch (err) {
    if (err.status) return res.status(err.status).json({ ok: false, message: err.message });
    return response.serverError(res, err);
  }
};

// POST /api/auth/logout
const logout = async (req, res) => {
  try {
    const token   = req.headers['authorization'].split(' ')[1];
    const payload = jwtUtil.verifyInternalToken(token);
    await service.logout(payload, false);
    return response.success(res, null, 'Sesión cerrada correctamente.');
  } catch (err) {
    return response.serverError(res, err);
  }
};

// POST /api/auth/portal/logout
const logoutPortal = async (req, res) => {
  try {
    const token   = req.headers['authorization'].split(' ')[1];
    const payload = jwtUtil.verifyPortalToken(token);
    await service.logout(payload, true);
    return response.success(res, null, 'Sesión cerrada correctamente.');
  } catch (err) {
    return response.serverError(res, err);
  }
};

// GET /api/auth/me — Devuelve el usuario autenticado actual
const me = (req, res) => {
  return response.success(res, req.user);
};

module.exports = { loginInternal, loginPortal, logout, logoutPortal, me };
