const bcrypt       = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const pool         = require('../../config/db');
const queries      = require('./auth.queries');
const jwtUtil      = require('../../utils/jwt');
const { getValue } = require('../systemConfig/systemConfig.queries');

const SALT_ROUNDS = 12;

// Calcula la fecha de expiración sumando N días a partir de ahora.
const _rtExpiresAt = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + parseInt(days || 7));
  return d;
};

// Mensajes y códigos estables de error de autenticación (documentados en README).
const MSG_BAD_CREDENTIALS = 'Credenciales incorrectas. Verificá tus datos e intentá nuevamente.';
const MSG_USER_LOCKED     = 'Tu cuenta fue bloqueada por seguridad. Comunicarte con el administrador del sistema para reactivarla.';
const MSG_PORTAL_GENERIC  = 'DNI o contraseña incorrectos. Verificá tus datos e intentá nuevamente.';
const MSG_SESSION_REVOKED = 'Sesión inválida por seguridad. Ingresá nuevamente.';

// Hash ficticio para igualar el tiempo de respuesta cuando el DNI no existe
// (evita enumerar cuentas por timing). Se calcula una sola vez, de forma diferida.
let _dummyHashPromise = null;
const _dummyCompare = async (password) => {
  if (!_dummyHashPromise) _dummyHashPromise = bcrypt.hash('dummy-password-no-match', SALT_ROUNDS);
  await bcrypt.compare(String(password || ''), await _dummyHashPromise);
};

/**
 * Error de bloqueo temporal de ADMIN con los segundos restantes.
 * @param {Date|string} lockedUntil - fin del bloqueo
 * @returns {Object} error con status 401, code ACCOUNT_TEMP_LOCKED y retry_after_seconds
 */
const _tempLockedError = (lockedUntil) => {
  const seconds = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 1000));
  const minutes = Math.ceil(seconds / 60);
  return {
    status: 401,
    code: 'ACCOUNT_TEMP_LOCKED',
    retry_after_seconds: seconds,
    message: `Demasiados intentos fallidos. Tu cuenta quedó bloqueada temporalmente; intentá nuevamente en ${minutes} minuto${minutes === 1 ? '' : 's'}.`,
  };
};

const _isFuture = (date) => !!date && new Date(date).getTime() > Date.now();

// ── Login sistema interno ─────────────────────────────────────────────────────
const loginInternal = async (dni, password) => {
  const [user, maxAttemptsStr, expiryHs, rtExpiryDays, lockMinutesStr] = await Promise.all([
    queries.findUserByDni(dni),
    getValue('login_max_attempts'),
    getValue('jwt_expiry_internal_hs'),
    getValue('rt_expiry_internal_days'),
    getValue('admin_lock_minutes'),
  ]);
  const maxAttempts = parseInt(maxAttemptsStr || '3');
  const lockMinutes = parseInt(lockMinutesStr || '15') || 15;

  if (!user) {
    await _dummyCompare(password);
    throw { status: 401, message: MSG_BAD_CREDENTIALS };
  }
  if (user.locked_at && user.role !== 'ADMIN') throw { status: 401, code: 'ACCOUNT_LOCKED', message: MSG_USER_LOCKED };
  if (user.role === 'ADMIN' && _isFuture(user.locked_until)) throw _tempLockedError(user.locked_until);
  if (user.status !== 'ACTIVE') throw { status: 401, message: 'Tu cuenta no está activa. Comunicarte con el administrador del sistema.' };

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    // Incremento y decisión de bloqueo en un solo UPDATE atómico (#35).
    const attempt = await queries.registerFailedAttempt(user.id, maxAttempts, lockMinutes);
    if (attempt && attempt.role !== 'ADMIN' && attempt.locked_at) {
      // Bloqueo permanente: cierra también las sesiones abiertas (#42).
      await queries.revokeAllUserRefreshTokens(user.id);
      throw { status: 401, code: 'ACCOUNT_LOCKED', message: MSG_USER_LOCKED };
    }
    if (attempt && attempt.role === 'ADMIN' && _isFuture(attempt.locked_until)) {
      throw _tempLockedError(attempt.locked_until);
    }
    throw { status: 401, message: MSG_BAD_CREDENTIALS };
  }

  await queries.resetFailedAttempts(user.id);

  const accessToken = jwtUtil.generateInternalToken(user, `${expiryHs || '8'}h`);
  const { raw: rtRaw, hashed: rtHashed } = jwtUtil.generateRefreshToken();
  const familyId  = uuidv4();
  const expiresAt = _rtExpiresAt(rtExpiryDays || 7);

  await queries.createRefreshToken(rtHashed, familyId, user.id, null, expiresAt);

  return {
    accessToken,
    refreshTokenRaw: rtRaw,
    rtExpiresAt: expiresAt,
    user: {
      id:               user.id,
      full_name:        user.full_name,
      dni:              user.dni,
      email:            user.email,
      role:             user.role,
      is_temp_password: user.is_temp_password,
    },
  };
};

// ── Login portal público ──────────────────────────────────────────────────────
const loginPortal = async (dni, password) => {
  const [customer, maxAttemptsStr, expiryMin, rtExpiryDays] = await Promise.all([
    queries.findCustomerByDni(dni),
    getValue('login_max_attempts'),
    getValue('jwt_expiry_portal_min'),
    getValue('rt_expiry_portal_days'),
  ]);
  const maxAttempts = parseInt(maxAttemptsStr || '3');

  // Mensaje genérico: no revela si el DNI existe, si el portal está habilitado
  // o si la cuenta está bloqueada (#35). El estado solo se informa con la
  // contraseña correcta.
  if (!customer || !customer.portal_enabled || customer.status !== 'ACTIVE' || !customer.portal_password_hash) {
    await _dummyCompare(password);
    throw { status: 401, message: MSG_PORTAL_GENERIC };
  }

  const valid = await bcrypt.compare(password, customer.portal_password_hash);
  if (!valid) {
    if (!customer.portal_locked_at) {
      const attempt = await queries.registerPortalFailedAttempt(customer.id, maxAttempts);
      if (attempt && attempt.portal_locked_at) {
        await queries.revokeAllCustomerRefreshTokens(customer.id);
      }
    }
    throw { status: 401, message: MSG_PORTAL_GENERIC };
  }

  if (customer.portal_locked_at) {
    throw { status: 401, code: 'ACCOUNT_LOCKED', message: 'Tu cuenta fue bloqueada por seguridad. Comunicarte con el negocio para reactivarla.' };
  }

  await queries.resetPortalFailedAttempts(customer.id);

  const accessToken = jwtUtil.generatePortalToken(customer, `${expiryMin || '30'}m`);
  const { raw: rtRaw, hashed: rtHashed } = jwtUtil.generateRefreshToken();
  const familyId  = uuidv4();
  const expiresAt = _rtExpiresAt(rtExpiryDays || 1);

  await queries.createRefreshToken(rtHashed, familyId, null, customer.id, expiresAt);

  return {
    accessToken,
    refreshTokenRaw: rtRaw,
    rtExpiresAt: expiresAt,
    customer: {
      id:                      customer.id,
      full_name:               customer.full_name,
      portal_is_temp_password: customer.portal_is_temp_password,
    },
  };
};

// ── Refresh — sistema interno ─────────────────────────────────────────────────
const refreshInternalToken = async (rawToken) => {
  if (!rawToken) throw { status: 401, message: 'Refresh token no encontrado.' };

  const hashed = jwtUtil.hashRefreshToken(rawToken);
  const stored = await queries.findRefreshToken(hashed);

  if (!stored) throw { status: 401, message: 'Refresh token inválido.' };

  // Detección de robo: token ya revocado → invalida toda la familia
  if (stored.revoked) {
    await queries.revokeFamilyRefreshTokens(stored.family_id);
    throw { status: 401, code: 'SESSION_REVOKED', message: MSG_SESSION_REVOKED };
  }

  if (new Date() > new Date(stored.expires_at)) {
    throw { status: 401, message: 'La sesión expiró. Ingresá nuevamente.' };
  }

  const [userResult, expiryHs, rtExpiryDays] = await Promise.all([
    pool.query(
      `SELECT id, full_name, role, status, is_temp_password, locked_at FROM users WHERE id = $1`,
      [stored.user_id]
    ),
    getValue('jwt_expiry_internal_hs'),
    getValue('rt_expiry_internal_days'),
  ]);

  const user = userResult.rows[0];
  if (!user || user.status !== 'ACTIVE') {
    throw { status: 401, code: 'SESSION_REVOKED', message: 'Tu cuenta no está activa.' };
  }
  // Usuario bloqueado por seguridad: no se emiten más access tokens (#42).
  if (user.locked_at && user.role !== 'ADMIN') {
    await queries.revokeAllUserRefreshTokens(user.id);
    throw { status: 401, code: 'SESSION_REVOKED', message: MSG_USER_LOCKED };
  }

  // Rotación atómica: solo un refresh concurrente gana la fila (#42).
  if (!(await queries.revokeRefreshTokenIfActive(stored.id))) {
    throw { status: 401, code: 'REFRESH_TOKEN_ROTATED', message: 'La sesión ya fue renovada. Ingresá nuevamente.' };
  }

  const accessToken = jwtUtil.generateInternalToken(user, `${expiryHs || '8'}h`);
  const { raw: newRtRaw, hashed: newRtHashed } = jwtUtil.generateRefreshToken();
  const expiresAt = _rtExpiresAt(rtExpiryDays || 7);

  await queries.createRefreshToken(newRtHashed, stored.family_id, stored.user_id, null, expiresAt);

  return { accessToken, refreshTokenRaw: newRtRaw, rtExpiresAt: expiresAt };
};

// ── Refresh — portal público ──────────────────────────────────────────────────
const refreshPortalToken = async (rawToken) => {
  if (!rawToken) throw { status: 401, message: 'Refresh token no encontrado.' };

  const hashed = jwtUtil.hashRefreshToken(rawToken);
  const stored = await queries.findRefreshToken(hashed);

  if (!stored) throw { status: 401, message: 'Refresh token inválido.' };

  if (stored.revoked) {
    await queries.revokeFamilyRefreshTokens(stored.family_id);
    throw { status: 401, code: 'SESSION_REVOKED', message: MSG_SESSION_REVOKED };
  }

  if (new Date() > new Date(stored.expires_at)) {
    throw { status: 401, message: 'La sesión expiró. Ingresá nuevamente.' };
  }

  const [customerResult, expiryMin, rtExpiryDays] = await Promise.all([
    pool.query(
      `SELECT id, full_name, status, portal_enabled, portal_is_temp_password, portal_locked_at
       FROM customers WHERE id = $1`,
      [stored.customer_id]
    ),
    getValue('jwt_expiry_portal_min'),
    getValue('rt_expiry_portal_days'),
  ]);

  const customer = customerResult.rows[0];
  if (!customer || customer.status !== 'ACTIVE' || !customer.portal_enabled || customer.portal_locked_at) {
    throw { status: 401, code: 'SESSION_REVOKED', message: 'Tu cuenta no está disponible.' };
  }

  // Rotación atómica: solo un refresh concurrente gana la fila (#42).
  if (!(await queries.revokeRefreshTokenIfActive(stored.id))) {
    throw { status: 401, code: 'REFRESH_TOKEN_ROTATED', message: 'La sesión ya fue renovada. Ingresá nuevamente.' };
  }

  const accessToken = jwtUtil.generatePortalToken(customer, `${expiryMin || '30'}m`);
  const { raw: newRtRaw, hashed: newRtHashed } = jwtUtil.generateRefreshToken();
  const expiresAt = _rtExpiresAt(rtExpiryDays || 1);

  await queries.createRefreshToken(newRtHashed, stored.family_id, null, stored.customer_id, expiresAt);

  return { accessToken, refreshTokenRaw: newRtRaw, rtExpiresAt: expiresAt };
};

// ── Logout ────────────────────────────────────────────────────────────────────
const logout = async (payload, isPortal = false, rawRefreshToken = null) => {
  const expiresAt = new Date(payload.exp * 1000);

  await queries.blacklistToken(
    payload.jti,
    isPortal ? null : payload.sub,
    isPortal ? payload.sub : null,
    expiresAt
  );

  if (rawRefreshToken) {
    const hashed = jwtUtil.hashRefreshToken(rawRefreshToken);
    const stored  = await queries.findRefreshToken(hashed);
    if (stored && !stored.revoked) {
      await queries.revokeRefreshToken(stored.id);
    }
  }
};

// ── Logout global — cierra todas las sesiones del usuario ─────────────────────
const logoutAll = async (payload, isPortal = false) => {
  const expiresAt = new Date(payload.exp * 1000);

  await queries.blacklistToken(
    payload.jti,
    isPortal ? null : payload.sub,
    isPortal ? payload.sub : null,
    expiresAt
  );

  if (isPortal) {
    await queries.revokeAllCustomerRefreshTokens(payload.sub);
  } else {
    await queries.revokeAllUserRefreshTokens(payload.sub);
  }
};

// ── Cambio de contraseña portal ───────────────────────────────────────────────
const changePortalPassword = async (customerId, currentPassword, newPassword) => {
  const customer = await queries.findCustomerPasswordHash(customerId);
  if (!customer) throw { status: 404, message: 'Cliente no encontrado.' };

  const valid = await bcrypt.compare(currentPassword, customer.portal_password_hash);
  if (!valid) throw { status: 401, message: 'La contraseña actual es incorrecta.' };

  if (currentPassword === newPassword)
    throw { status: 400, message: 'La nueva contraseña no puede ser igual a la actual.' };

  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await queries.changePortalPassword(customerId, hash);
};

module.exports = {
  loginInternal, loginPortal,
  refreshInternalToken, refreshPortalToken,
  logout, logoutAll,
  changePortalPassword,
};
