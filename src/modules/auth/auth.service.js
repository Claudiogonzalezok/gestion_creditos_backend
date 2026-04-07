const bcrypt  = require('bcryptjs');
const queries = require('./auth.queries');
const jwtUtil = require('../../utils/jwt');

const MAX_ATTEMPTS = parseInt(process.env.LOGIN_MAX_ATTEMPTS || '3');

// ── Login sistema interno ─────────────────────────────────────
const loginInternal = async (dni, password) => {
  const user = await queries.findUserByDni(dni);

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
    const remaining = MAX_ATTEMPTS - (user.failed_attempts + 1);
    if (remaining <= 0) {
      await queries.lockUser(user.id);
      throw { status: 401, message: 'Tu cuenta fue bloqueada por seguridad. Comunicarte con el administrador del sistema para reactivarla.' };
    }
    throw { status: 401, message: 'Credenciales incorrectas. Verificá tus datos e intentá nuevamente.' };
  }

  // Login exitoso
  await queries.resetFailedAttempts(user.id);
  const token = jwtUtil.generateInternalToken(user);

  return {
    token,
    user: {
      id:               user.id,
      full_name:        user.full_name,
      dni:              user.dni,
      role:             user.role,
      is_temp_password: user.is_temp_password,
    },
  };
};

// ── Login portal público ──────────────────────────────────────
const loginPortal = async (dni, password) => {
  const customer = await queries.findCustomerByDni(dni);

  if (!customer) throw { status: 401, message: 'DNI o contraseña incorrectos. Verificá tus datos e intentá nuevamente.' };

  if (!customer.portal_enabled) throw { status: 401, message: 'Tu acceso al portal aún no fue habilitado. Comunicarte con el negocio para solicitarlo.' };

  if (customer.status !== 'ACTIVE') throw { status: 401, message: 'Tu cuenta no está disponible. Comunicarte con el negocio para más información.' };

  if (customer.portal_locked_at) throw { status: 401, message: 'Tu cuenta fue bloqueada por seguridad. Comunicarte con el negocio para reactivarla.' };

  const valid = await bcrypt.compare(password, customer.portal_password_hash);
  if (!valid) {
    await queries.incrementPortalFailedAttempts(customer.id);
    const remaining = MAX_ATTEMPTS - (customer.portal_failed_attempts + 1);
    if (remaining <= 0) {
      await queries.lockCustomer(customer.id);
      throw { status: 401, message: 'Tu cuenta fue bloqueada por seguridad. Comunicarte con el negocio para reactivarla.' };
    }
    throw { status: 401, message: 'DNI o contraseña incorrectos. Verificá tus datos e intentá nuevamente.' };
  }

  await queries.resetPortalFailedAttempts(customer.id);
  const token = jwtUtil.generatePortalToken(customer);

  return {
    token,
    customer: {
      id:                     customer.id,
      full_name:              customer.full_name,
      dni:                    customer.dni,
      portal_is_temp_password: customer.portal_is_temp_password,
    },
  };
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

module.exports = { loginInternal, loginPortal, logout };
