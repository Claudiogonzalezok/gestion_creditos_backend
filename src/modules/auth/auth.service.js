const bcrypt       = require('bcryptjs');
const queries      = require('./auth.queries');
const jwtUtil      = require('../../utils/jwt');
const { getValue } = require('../systemConfig/systemConfig.queries');

const SALT_ROUNDS = 12;

// ── Login sistema interno ─────────────────────────────────────
const loginInternal = async (dni, password) => {
  const [user, maxAttemptsStr, expiryHs] = await Promise.all([
    queries.findUserByDni(dni),
    getValue('login_max_attempts'),
    getValue('jwt_expiry_internal_hs'),
  ]);
  const maxAttempts = parseInt(maxAttemptsStr || '3');

  // Usuario no encontrado — mismo mensaje para no revelar si existe
  if (!user) throw { status: 401, message: 'Credenciales incorrectas. Verificá tus datos e intentá nuevamente.' };

  // Cuenta bloqueada
  if (user.locked_at) throw { status: 401, message: 'Tu cuenta fue bloqueada por seguridad. Comunicarte con el administrador del sistema para reactivarla.' };

  // Cuenta inactiva
  if (user.status !== 'ACTIVE') throw { status: 401, message: 'Tu cuenta no está activa. Comunicarte con el administrador del sistema.' };

  // Verificar contraseña
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    await queries.incrementFailedAttempts(user.id);
    const remaining = maxAttempts - (user.failed_attempts + 1);
    if (remaining <= 0) {
      await queries.lockUser(user.id);
      throw { status: 401, message: 'Tu cuenta fue bloqueada por seguridad. Comunicarte con el administrador del sistema para reactivarla.' };
    }
    throw { status: 401, message: 'Credenciales incorrectas. Verificá tus datos e intentá nuevamente.' };
  }

  // Login exitoso
  await queries.resetFailedAttempts(user.id);
  const token = jwtUtil.generateInternalToken(user, `${expiryHs || '8'}h`);

  return {
    token,
    user: {
      id:               user.id,
      full_name:        user.full_name,
      role:             user.role,
      is_temp_password: user.is_temp_password,
    },
  };
};

// ── Login portal público ──────────────────────────────────────
const loginPortal = async (dni, password) => {
  const [customer, maxAttemptsStr, expiryMin] = await Promise.all([
    queries.findCustomerByDni(dni),
    getValue('login_max_attempts'),
    getValue('jwt_expiry_portal_min'),
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
  const token = jwtUtil.generatePortalToken(customer, `${expiryMin || '30'}m`);

  return {
    token,
    customer: {
      id:                      customer.id,
      full_name:               customer.full_name,
      portal_is_temp_password: customer.portal_is_temp_password,
    },
  };
};

// ── Cambio de contraseña portal ───────────────────────────────
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

// ── Logout: agregar token a blacklist ─────────────────────────
const logout = async (payload, isPortal = false) => {
  const expiresAt = new Date(payload.exp * 1000);
  await queries.blacklistToken(
    payload.jti,
    isPortal ? null : payload.sub,
    isPortal ? payload.sub : null,
    expiresAt
  );
};

module.exports = { loginInternal, loginPortal, changePortalPassword, logout };
