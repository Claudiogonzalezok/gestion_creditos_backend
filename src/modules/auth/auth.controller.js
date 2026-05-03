const pool     = require('../../config/db');
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
    if (err.status === 401) return response.unauthorized(res, err.message);
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
    if (err.status === 401) return response.unauthorized(res, err.message);
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
const me = async (req, res) => {
  try {
    const { id, full_name, role, status, is_temp_password } = req.user;
    const data = { id, full_name, role, status, is_temp_password };

    if (role === 'ADMIN') {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS count FROM credits WHERE status = 'PENDING_APPROVAL'`
      );
      data.pending_approvals_count = r.rows[0].count;
    }

    return response.success(res, data);
  } catch (err) {
    return response.serverError(res, err);
  }
};

module.exports = { loginInternal, loginPortal, logout, logoutPortal, me };
