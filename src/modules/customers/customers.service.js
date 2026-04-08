const bcrypt  = require('bcryptjs');
const queries = require('./customers.queries');
const { generateTempPassword } = require('../../utils/tempPassword');

const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10');

/**
 * Elimina el campo address del objeto si el rol solicitante es COLLECTOR (CU06).
 */
const stripFieldsByRole = (customer, requestingUser) => {
  if (requestingUser.role === 'COLLECTOR') {
    const { address, ...rest } = customer;
    return rest;
  }
  return customer;
};

const getAll = async (filters, requestingUser) => {
  // COLLECTOR solo ve sus propios clientes asignados
  if (requestingUser.role === 'COLLECTOR') {
    filters = { ...filters, collector_id: requestingUser.id };
  }
  const results = await queries.findAll(filters);
  return results.map(c => stripFieldsByRole(c, requestingUser));
};

const getById = async (id, requestingUser) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: 'Cliente no encontrado.' };
  return stripFieldsByRole(customer, requestingUser);
};

const create = async (data) => {
  // Validar DNI único
  if (await queries.findByDni(data.dni))
    throw { status: 409, message: 'Ya existe un cliente registrado con ese DNI.' };

  // Validar que el cobrador asignado exista y tenga rol COLLECTOR
  if (data.assigned_collector_id) {
    const collector = await queries.findCollectorById(data.assigned_collector_id);
    if (!collector)
      throw { status: 404, message: 'El cobrador asignado no existe o no tiene el rol de Cobrador.' };
  }

  return queries.create(data);
};

const update = async (id, data) => {
  const existing = await queries.findById(id);
  if (!existing) throw { status: 404, message: 'Cliente no encontrado.' };

  // Validar que el nuevo cobrador asignado tenga rol COLLECTOR
  if (data.assigned_collector_id && data.assigned_collector_id !== existing.collector_id) {
    const collector = await queries.findCollectorById(data.assigned_collector_id);
    if (!collector)
      throw { status: 404, message: 'El cobrador asignado no existe o no tiene el rol de Cobrador.' };
  }

  // DNI no se puede modificar
  return queries.update(id, data);
};

const deactivate = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: 'Cliente no encontrado.' };
  if (customer.status === 'INACTIVE')
    throw { status: 409, message: 'El cliente ya está inactivo.' };
  if (await queries.hasActiveOrPendingCredits(id))
    throw { status: 409, message: 'No se puede desactivar un cliente con créditos activos o pendientes de aprobación.' };
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
  if (customer.portal_enabled)
    throw { status: 409, message: 'El portal ya está habilitado para este cliente.' };

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
