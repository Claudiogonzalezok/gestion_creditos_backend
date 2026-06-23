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

// ── Login sistema interno ─────────────────────────────────────────────────────
const loginInternal = async (dni, password) => {
  const [user, maxAttemptsStr, expiryHs, rtExpiryDays] = await Promise.all([
    queries.findUserByDni(dni),
    getValue('login_max_attempts'),
    getValue('jwt_expiry_internal_hs'),
    getValue('rt_expiry_internal_days'),
  ]);
  const maxAttempts = parseInt(maxAttemptsStr || '3');

  if (!user) throw { status: 401, message: 'Credenciales incorrectas. Verificá tus datos e intentá nuevamente.' };
  if (user.locked_at && user.role !== 'ADMIN') throw { status: 401, message: 'Tu cuenta fue bloqueada por seguridad. Comunicarte con el administrador del sistema para reactivarla.' };
  if (user.status !== 'ACTIVE') throw { status: 401, message: 'Tu cuenta no está activa. Comunicarte con el administrador del sistema.' };

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    await queries.incrementFailedAttempts(user.id);
    const remaining = maxAttempts - (user.failed_attempts + 1);
    if (remaining <= 0) {
      if (user.role !== 'ADMIN') {
        await queries.lockUser(user.id);
        throw { status: 401, message: 'Tu cuenta fue bloqueada por seguridad. Comunicarte con el administrador del sistema para reactivarla.' };
      }
    }
    throw { status: 401, message: 'Credenciales incorrectas. Verificá tus datos e intentá nuevamente.' };
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

  if (!customer) throw { status: 401, message: 'DNI o contraseña incorrectos. Verificá tus datos e intentá nuevamente.' };
  if (!customer.portal_enabled) throw { status: 401, message: 'Tu acceso al portal aún no fue habilitado. Comunicarte con el negocio para solicitarlo.' };
  if (customer.status !== 'ACTIVE') throw { status: 401, message: 'Tu cuenta no está disponible. Comunicarte con el negocio para más información.' };
  if (customer.portal_locked_at) throw { status: 401, message: 'Tu cuenta fue bloqueada por seguridad. Comunicarte con el negocio para reactivarla.' };

  const valid = await bcrypt.compare(password, customer.portal_password_hash);
  if (!valid) {
    await queries.incrementPortalFailedAttempts(customer.id);
    const remaining = maxAttempts - (customer.portal_failed_attempts + 1);
    if (remaining <= 0) {
      await queries.lockCustomer(customer.id);
      throw { status: 401, message: 'Tu cuenta fue bloqueada por seguridad. Comunicarte con el negocio para reactivarla.' };
    }
    throw { status: 401, message: 'DNI o contraseña incorrectos. Verificá tus datos e intentá nuevamente.' };
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
    throw { status: 401, message: 'Sesión inválida por seguridad. Ingresá nuevamente.' };
  }

  if (new Date() > new Date(stored.expires_at)) {
    throw { status: 401, message: 'La sesión expiró. Ingresá nuevamente.' };
  }

  const [userResult, expiryHs, rtExpiryDays] = await Promise.all([
    pool.query(
      `SELECT id, full_name, role, status, is_temp_password FROM users WHERE id = $1`,
      [stored.user_id]
    ),
    getValue('jwt_expiry_internal_hs'),
    getValue('rt_expiry_internal_days'),
  ]);

  const user = userResult.rows[0];
  if (!user || user.status !== 'ACTIVE') {
    throw { status: 401, message: 'Tu cuenta no está activa.' };
  }

  // Rotación: revocar el token usado, emitir uno nuevo en la misma familia
  await queries.revokeRefreshToken(stored.id);

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
    throw { status: 401, message: 'Sesión inválida por seguridad. Ingresá nuevamente.' };
  }

  if (new Date() > new Date(stored.expires_at)) {
    throw { status: 401, message: 'La sesión expiró. Ingresá nuevamente.' };
  }

  const [customerResult, expiryMin, rtExpiryDays] = await Promise.all([
    pool.query(
      `SELECT id, full_name, status, portal_enabled, portal_is_temp_password FROM customers WHERE id = $1`,
      [stored.customer_id]
    ),
    getValue('jwt_expiry_portal_min'),
    getValue('rt_expiry_portal_days'),
  ]);

  const customer = customerResult.rows[0];
  if (!customer || customer.status !== 'ACTIVE' || !customer.portal_enabled) {
    throw { status: 401, message: 'Tu cuenta no está disponible.' };
  }

  await queries.revokeRefreshToken(stored.id);

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
