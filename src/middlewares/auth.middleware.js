const pool          = require('../config/db');
const { verifyInternalToken, verifyPortalToken, extractToken } = require('../utils/jwt');
const response      = require('../utils/response');

// ── Helper interno: verifica blacklist y estado del usuario ───
// allowTempPassword: true en la ruta de cambio de contraseña para
// que el usuario con contraseña temporal pueda usarla sin bloquearse.
const _verifyInternalSession = async (req, res, next, allowTempPassword) => {
  const token = extractToken(req);
  if (!token) return response.unauthorized(res);

  // Verificar firma y expiración del JWT
  let payload;
  try {
    payload = verifyInternalToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return response.unauthorized(res, 'Tu sesión expiró. Ingresá nuevamente.');
    }
    return response.unauthorized(res);
  }

  // Verificar blacklist y estado del usuario en la DB
  try {
    const blacklisted = await pool.query(
      'SELECT id FROM token_blacklist WHERE token_jti = $1',
      [payload.jti]
    );
    if (blacklisted.rows.length > 0) {
      return response.unauthorized(res, 'La sesión fue cerrada. Ingresá nuevamente.');
    }

    const user = await pool.query(
      `SELECT id, full_name, dni, role, status, is_temp_password, force_relogin_at
       FROM users WHERE id = $1`,
      [payload.sub]
    );
    if (!user.rows.length || user.rows[0].status !== 'ACTIVE') {
      return response.unauthorized(res, 'Tu cuenta no está activa.');
    }

    // Verificar invalidación forzada por cambio de rol (CU02)
    // Requiere columna force_relogin_at TIMESTAMPTZ en la tabla users.
    if (user.rows[0].force_relogin_at) {
      const tokenIat       = payload.iat; // segundos (epoch)
      const forceReloginAt = Math.floor(new Date(user.rows[0].force_relogin_at).getTime() / 1000);
      if (tokenIat < forceReloginAt) {
        return response.unauthorized(res, 'Tu sesión fue invalidada. Ingresá nuevamente.');
      }
    }

    // Bloquear acceso si la contraseña es temporal, salvo en la ruta de cambio
    if (!allowTempPassword && user.rows[0].is_temp_password) {
      return response.forbidden(res, 'Debés cambiar tu contraseña antes de continuar.');
    }

    req.user = user.rows[0];
    next();
  } catch (err) {
    console.error('Error de base de datos en authenticate:', err);
    return response.serverError(res, err);
  }
};

// ── Middleware: verificar token de sistema interno ────────────
// Bloquea usuarios con contraseña temporal (deben cambiarla primero).
const authenticate = (req, res, next) => _verifyInternalSession(req, res, next, false);

// ── Middleware: igual que authenticate pero permite contraseña temporal ──
// Usar exclusivamente en la ruta PATCH /me/change-password para que el
// usuario con contraseña temporal pueda cambiarla.
const authenticateAllowTemp = (req, res, next) => _verifyInternalSession(req, res, next, true);

// ── Middleware: verificar token del portal público ─────────────
const authenticatePortal = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return response.unauthorized(res);

  // Verificar firma y expiración del JWT
  let payload;
  try {
    payload = verifyPortalToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return response.unauthorized(res, 'Tu sesión expiró. Ingresá nuevamente.');
    }
    return response.unauthorized(res);
  }

  // Verificar blacklist y estado del cliente en la DB
  try {
    const blacklisted = await pool.query(
      'SELECT id FROM token_blacklist WHERE token_jti = $1',
      [payload.jti]
    );
    if (blacklisted.rows.length > 0) {
      return response.unauthorized(res, 'La sesión fue cerrada. Ingresá nuevamente.');
    }

    const customer = await pool.query(
      'SELECT id, full_name, dni, status, portal_enabled FROM customers WHERE id = $1',
      [payload.sub]
    );
    if (!customer.rows.length || customer.rows[0].status !== 'ACTIVE') {
      return response.unauthorized(res, 'Tu cuenta no está disponible.');
    }
    if (!customer.rows[0].portal_enabled) {
      return response.unauthorized(res, 'Tu acceso al portal aún no fue habilitado.');
    }

    req.customer = customer.rows[0];
    next();
  } catch (err) {
    console.error('Error de base de datos en authenticatePortal:', err);
    return response.serverError(res, err);
  }
};

// ── Middleware: verificar roles ───────────────────────────────
// Uso: authorize('ADMIN') o authorize('ADMIN', 'SELLER')
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) return response.unauthorized(res);
    if (!roles.includes(req.user.role)) {
      return response.forbidden(res);
    }
    next();
  };
};

module.exports = { authenticate, authenticateAllowTemp, authenticatePortal, authorize };
