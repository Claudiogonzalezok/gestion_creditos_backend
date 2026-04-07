const pool          = require('../config/db');
const { verifyInternalToken, verifyPortalToken, extractToken } = require('../utils/jwt');
const response      = require('../utils/response');

// ── Middleware: verificar token de sistema interno ────────────
const authenticate = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return response.unauthorized(res);

  try {
    const payload = verifyInternalToken(token);

    // Verificar que el token no esté en la blacklist
    const blacklisted = await pool.query(
      'SELECT id FROM token_blacklist WHERE token_jti = $1',
      [payload.jti]
    );
    if (blacklisted.rows.length > 0) {
      return response.unauthorized(res, 'La sesión fue cerrada. Ingresá nuevamente.');
    }

    // Verificar que el usuario siga activo
    const user = await pool.query(
      'SELECT id, full_name, dni, role, status, is_temp_password FROM users WHERE id = $1',
      [payload.sub]
    );
    if (!user.rows.length || user.rows[0].status !== 'ACTIVE') {
      return response.unauthorized(res, 'Tu cuenta no está activa.');
    }

    req.user = user.rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return response.unauthorized(res, 'Tu sesión expiró. Ingresá nuevamente.');
    }
    return response.unauthorized(res);
  }
};

// ── Middleware: verificar token del portal público ─────────────
const authenticatePortal = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return response.unauthorized(res);

  try {
    const payload = verifyPortalToken(token);

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
    if (err.name === 'TokenExpiredError') {
      return response.unauthorized(res, 'Tu sesión expiró. Ingresá nuevamente.');
    }
    return response.unauthorized(res);
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

module.exports = { authenticate, authenticatePortal, authorize };
