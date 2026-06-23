const bcrypt = require("bcryptjs");
const queries = require("./customers.queries");
const { getValue } = require("../systemConfig/systemConfig.queries");
const { generateTempPassword } = require("../../utils/tempPassword");
const notificationsService = require("../notifications/notifications.service");
const notificationsQueries = require("../notifications/notifications.queries");

/**
 * Hook: notifica a los admins activos que se registró un nuevo cliente.
 * Best-effort — un fallo de notify() nunca debe afectar el alta ya persistida.
 * @param {object} customer - Cliente recién creado.
 */
const _notifyNewCustomer = async (customer) => {
  try {
    const adminIds = await notificationsQueries.getActiveAdminUserIds();
    await notificationsService.notify({
      type: "NEW_CUSTOMER",
      title: "Nuevo cliente registrado",
      message: `Se registró el cliente "${customer.full_name}" (DNI ${customer.dni}).`,
      targetUserIds: adminIds,
      channels: ["push"],
      entityType: "customer",
      entityId: customer.id,
    });
  } catch (err) {
    console.error("🔴  [notifications] Falló el hook de NEW_CUSTOMER:", err);
  }
};

/**
 * Días de gracia para considerar una cuota vencida en queries que usan la
 * condición derivada (IS_OVERDUE_DERIVED).
 * @returns {Promise<number>}
 */
const getGraceDays = async () =>
  parseInt((await getValue("penalty_grace_days")) || "3");

const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || "10");

/**
 * Elimina el campo address del objeto si el rol solicitante es COLLECTOR (CU06).
 */
const IS_COLLECTOR = (role) => ["COLLECTOR", "SELLER_COLLECTOR"].includes(role);

const stripFieldsByRole = (customer, requestingUser) => {
  // COLLECTOR y SELLER_COLLECTOR no ven el domicilio completo (CU06)
  if (IS_COLLECTOR(requestingUser.role)) {
    const { address, ...rest } = customer;
    return rest;
  }
  return customer;
};

const getAll = async (filters, requestingUser) => {
  const normalizedFilters = {
    ...filters,
    include_summary: filters?.include_summary === "true",
  };

  // COLLECTOR puro solo ve sus propios clientes asignados
  // SELLER_COLLECTOR ve todos (tiene rol vendedor también)
  if (requestingUser.role === "COLLECTOR") {
    normalizedFilters.collector_id = requestingUser.id;
  }
  if (normalizedFilters.include_summary) {
    normalizedFilters.grace_days = await getGraceDays();
  }
  const results = await queries.findAll(normalizedFilters);
  return results.map((c) => stripFieldsByRole(c, requestingUser));
};

const getById = async (id, requestingUser) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: "Cliente no encontrado." };
  return stripFieldsByRole(customer, requestingUser);
};

/**
 * Devuelve el resumen enriquecido del cliente para el wizard de nueva operación.
 * @param {string} id
 * @param {{ role: string, id: string }} requestingUser
 * @returns {Promise<object>}
 */
const getWizardSummary = async (id, requestingUser) => {
  const summary = await queries.findWizardSummaryById(id, await getGraceDays());
  if (!summary) throw { status: 404, message: "Cliente no encontrado." };

  if (
    requestingUser.role === "COLLECTOR" &&
    summary.collector_id !== requestingUser.id
  ) {
    throw { status: 404, message: "Cliente no encontrado." };
  }

  const baseCustomer = stripFieldsByRole(
    {
      id: summary.id,
      full_name: summary.full_name,
      dni: summary.dni,
      address: summary.address,
      phone: summary.phone,
      email: summary.email,
      status: summary.status,
      portal_enabled: summary.portal_enabled,
      created_at: summary.created_at,
      collector_id: summary.collector_id,
      collector_name: summary.collector_name,
    },
    requestingUser,
  );

  return {
    ...baseCustomer,
    delinquency: summary.overdue_installments > 0 ? "con mora" : "sin mora",
    payment_capacity: summary.payment_capacity,
    active_credits: summary.active_credits,
    paid_installments: summary.paid_installments,
    pending_installments: summary.pending_installments,
    overdue_installments: summary.overdue_installments,
    credits: summary.credits,
  };
};

const create = async (data) => {
  // Validar DNI único
  if (await queries.findByDni(data.dni))
    throw {
      status: 409,
      message: "Ya existe un cliente registrado con ese DNI.",
    };

  // Validar que el cobrador asignado exista y tenga rol COLLECTOR
  if (data.assigned_collector_id) {
    const collector = await queries.findCollectorById(
      data.assigned_collector_id,
    );
    if (!collector)
      throw {
        status: 404,
        message:
          "El cobrador asignado no existe o no tiene el rol de Cobrador.",
      };
  }

  const customer = await queries.create(data);
  await _notifyNewCustomer(customer);
  return customer;
};

const update = async (id, data) => {
  const existing = await queries.findById(id);
  if (!existing) throw { status: 404, message: "Cliente no encontrado." };

  // Validar que el nuevo cobrador asignado tenga rol COLLECTOR
  if (
    data.assigned_collector_id &&
    data.assigned_collector_id !== existing.collector_id
  ) {
    const collector = await queries.findCollectorById(
      data.assigned_collector_id,
    );
    if (!collector)
      throw {
        status: 404,
        message:
          "El cobrador asignado no existe o no tiene el rol de Cobrador.",
      };
  }

  // DNI no se puede modificar
  return queries.update(id, data);
};

const deactivate = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: "Cliente no encontrado." };
  if (customer.status === "INACTIVE")
    throw { status: 409, message: "El cliente ya está inactivo." };
  if (await queries.hasActiveOrPendingCredits(id))
    throw {
      status: 409,
      message:
        "No se puede desactivar un cliente con créditos activos o pendientes de aprobación.",
    };
  await queries.deactivate(id);
};

const activate = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: "Cliente no encontrado." };
  if (customer.status === "ACTIVE")
    throw { status: 409, message: "El cliente ya está activo." };
  await queries.activate(id);
};

// ── Portal público ────────────────────────────────────────────

const enablePortal = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: "Cliente no encontrado." };
  if (customer.status !== "ACTIVE")
    throw {
      status: 409,
      message: "No se puede habilitar el portal de un cliente inactivo.",
    };
  if (customer.portal_enabled)
    throw {
      status: 409,
      message: "El portal ya está habilitado para este cliente.",
    };

  const tempPassword = generateTempPassword();
  const password_hash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
  await queries.enablePortal(id, password_hash);

  return { tempPassword };
};

const disablePortal = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: "Cliente no encontrado." };
  if (!customer.portal_enabled)
    throw {
      status: 409,
      message: "El portal ya está deshabilitado para este cliente.",
    };
  await queries.disablePortal(id);
};

const resetPortalPassword = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: "Cliente no encontrado." };
  if (!customer.portal_enabled)
    throw {
      status: 409,
      message: "El cliente no tiene acceso al portal habilitado.",
    };

  const tempPassword = generateTempPassword();
  const password_hash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
  await queries.resetPortalPassword(id, password_hash);

  return { tempPassword };
};

const unlockPortal = async (id) => {
  const customer = await queries.findById(id);
  if (!customer) throw { status: 404, message: "Cliente no encontrado." };
  if (!customer.portal_locked_at)
    throw { status: 409, message: "El cliente no está bloqueado." };
  await queries.unlockPortal(id);
};

module.exports = {
  getAll,
  getById,
  getWizardSummary,
  create,
  update,
  deactivate,
  activate,
  enablePortal,
  disablePortal,
  resetPortalPassword,
  unlockPortal,
};
