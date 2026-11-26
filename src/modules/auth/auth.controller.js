const pool     = require('../../config/db');
const service  = require('./auth.service');
const response = require('../../utils/response');
const jwtUtil  = require('../../utils/jwt');

const RT_COOKIE = 'rt';

const _rtCookieOptions = (expires) => ({
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path:     '/api/auth',
  expires,
});

/**
 * Responde 401 conservando la forma { ok, message } y agregando, si existen,
 * `code` (ACCOUNT_LOCKED, ACCOUNT_TEMP_LOCKED, SESSION_REVOKED,
 * REFRESH_TOKEN_ROTATED) y `retry_after_seconds` (+ header Retry-After).
 */
const _authError = (res, err) => {
  const body = { ok: false, message: err.message };
  if (err.code) body.code = err.code;
  if (err.retry_after_seconds) {
    body.retry_after_seconds = err.retry_after_seconds;
    res.set('Retry-After', String(err.retry_after_seconds));
  }
  return res.status(401).json(body);
};

// POST /api/auth/login
const loginInternal = async (req, res) => {
  try {
    const { dni, password } = req.body;
    const result = await service.loginInternal(dni, password);

    res.cookie(RT_COOKIE, result.refreshTokenRaw, _rtCookieOptions(result.rtExpiresAt));

    return response.success(res, {
      token: result.accessToken,
      user:  result.user,
    }, 'Inicio de sesión exitoso.');
  } catch (err) {
    if (err.status === 401) return _authError(res, err);
    return response.serverError(res, err);
  }
};

// POST /api/auth/portal/login
const loginPortal = async (req, res) => {
  try {
    const { dni, password } = req.body;
    const result = await service.loginPortal(dni, password);

    res.cookie(RT_COOKIE, result.refreshTokenRaw, _rtCookieOptions(result.rtExpiresAt));

    return response.success(res, {
      token:    result.accessToken,
      customer: result.customer,
    }, 'Inicio de sesión exitoso.');
  } catch (err) {
    if (err.status === 401) return _authError(res, err);
    return response.serverError(res, err);
  }
};

// POST /api/auth/refresh
const refreshInternal = async (req, res) => {
  try {
    const rawToken = req.cookies?.[RT_COOKIE];
    const result   = await service.refreshInternalToken(rawToken);

    res.cookie(RT_COOKIE, result.refreshTokenRaw, _rtCookieOptions(result.rtExpiresAt));

    return response.success(res, { token: result.accessToken }, 'Token renovado correctamente.');
  } catch (err) {
    if (err.status === 401) return _authError(res, err);
    return response.serverError(res, err);
  }
};

// POST /api/auth/portal/refresh
const refreshPortal = async (req, res) => {
  try {
    const rawToken = req.cookies?.[RT_COOKIE];
    const result   = await service.refreshPortalToken(rawToken);

    res.cookie(RT_COOKIE, result.refreshTokenRaw, _rtCookieOptions(result.rtExpiresAt));

    return response.success(res, { token: result.accessToken }, 'Token renovado correctamente.');
  } catch (err) {
    if (err.status === 401) return _authError(res, err);
    return response.serverError(res, err);
  }
};

// POST /api/auth/logout
const logout = async (req, res) => {
  try {
    const token   = req.headers['authorization'].split(' ')[1];
    const payload = jwtUtil.verifyInternalToken(token);
    await service.logout(payload, false, req.cookies?.[RT_COOKIE]);

    res.clearCookie(RT_COOKIE, { path: '/api/auth' });
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
    await service.logout(payload, true, req.cookies?.[RT_COOKIE]);

    res.clearCookie(RT_COOKIE, { path: '/api/auth' });
    return response.success(res, null, 'Sesión cerrada correctamente.');
  } catch (err) {
    return response.serverError(res, err);
  }
};

// POST /api/auth/logout/all
const logoutAll = async (req, res) => {
  try {
    const token   = req.headers['authorization'].split(' ')[1];
    const payload = jwtUtil.verifyInternalToken(token);
    await service.logoutAll(payload, false);

    res.clearCookie(RT_COOKIE, { path: '/api/auth' });
    return response.success(res, null, 'Sesión cerrada en todos los dispositivos.');
  } catch (err) {
    return response.serverError(res, err);
  }
};

// POST /api/auth/portal/logout/all
const logoutAllPortal = async (req, res) => {
  try {
    const token   = req.headers['authorization'].split(' ')[1];
    const payload = jwtUtil.verifyPortalToken(token);
    await service.logoutAll(payload, true);

    res.clearCookie(RT_COOKIE, { path: '/api/auth' });
    return response.success(res, null, 'Sesión cerrada en todos los dispositivos.');
  } catch (err) {
    return response.serverError(res, err);
  }
};

// GET /api/auth/me
const me = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, dni, email, phone, address, role, status,
              is_temp_password, force_relogin_at, last_login_at, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (!result.rows.length) return response.notFound(res, 'Usuario no encontrado.');

    const data = result.rows[0];
    const { role } = data;

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

module.exports = {
  loginInternal, loginPortal,
  refreshInternal, refreshPortal,
  logout, logoutPortal,
  logoutAll, logoutAllPortal,
  changePortalPassword: async (req, res) => {
    try {
      const { current_password, new_password } = req.body;
      await service.changePortalPassword(req.customer.id, current_password, new_password);
      return response.success(res, null, 'Contraseña cambiada correctamente.');
    } catch (err) {
      if (err.status === 401) return response.unauthorized(res, err.message);
      if (err.status === 400) return response.badRequest(res, err.message);
      return response.serverError(res, err);
    }
  },
  me,
};
