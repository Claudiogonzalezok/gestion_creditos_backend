const bcrypt  = require('bcryptjs');
const queries = require('./customers.queries');

const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10');

const generateTempPassword = () => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pass = '';
  for (let i = 0; i < 8; i++) pass += chars[Math.floor(Math.random() * chars.length)];
  return pass;
};

const getAll = async (filters) => {
  return queries.findAll(filters);
};

const getById = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: 'Cliente no encontrado.' };
  return customer;
};

const create = async (data) => {
  // Validar DNI único
  if (await queries.findByDni(data.dni))
    throw { status: 409, message: 'Ya existe un cliente registrado con ese DNI.' };
  return queries.create(data);
};

const update = async (id, data) => {
  const existing = await queries.findById(id);
  if (!existing) throw { status: 404, message: 'Cliente no encontrado.' };
  // DNI no se puede modificar
  return queries.update(id, data);
};

const deactivate = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: 'Cliente no encontrado.' };
  if (customer.status === 'INACTIVE')
    throw { status: 409, message: 'El cliente ya está inactivo.' };
  if (await queries.hasActiveCredits(id))
    throw { status: 409, message: 'No se puede desactivar un cliente con créditos activos.' };
  await queries.deactivate(id);
};

const activate = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: 'Cliente no encontrado.' };
  if (customer.status === 'ACTIVE')
    throw { status: 409, message: 'El cliente ya está activo.' };
  await queries.activate(id);
};

// ── Portal público ────────────────────────────────────────────

const enablePortal = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: 'Cliente no encontrado.' };
  if (customer.status !== 'ACTIVE')
    throw { status: 409, message: 'No se puede habilitar el portal de un cliente inactivo.' };

  const tempPassword  = generateTempPassword();
  const password_hash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
  await queries.enablePortal(id, password_hash);

  return { tempPassword };
};

const disablePortal = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: 'Cliente no encontrado.' };
  if (!customer.portal_enabled)
    throw { status: 409, message: 'El portal ya está deshabilitado para este cliente.' };
  await queries.disablePortal(id);
};

const resetPortalPassword = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: 'Cliente no encontrado.' };
  if (!customer.portal_enabled)
    throw { status: 409, message: 'El cliente no tiene acceso al portal habilitado.' };

  const tempPassword  = generateTempPassword();
  const password_hash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
  await queries.resetPortalPassword(id, password_hash);

  return { tempPassword };
};

const unlockPortal = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: 'Cliente no encontrado.' };
  if (!customer.portal_locked_at)
    throw { status: 409, message: 'El cliente no está bloqueado.' };
  await queries.unlockPortal(id);
};

module.exports = {
  getAll, getById, create, update, deactivate, activate,
  enablePortal, disablePortal, resetPortalPassword, unlockPortal,
};
