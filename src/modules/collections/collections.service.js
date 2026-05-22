const queries = require('./collections.queries');
const { withTransaction } = require('../../utils/transaction');

/**
 * Toma un lock transaccional por cobrador+fecha para evitar generaciones concurrentes de la misma planilla.
 * @param {import('pg').PoolClient} client - Cliente transaccional activo.
 * @param {string} collectorId - ID del cobrador.
 * @param {string} date - Fecha de planilla (YYYY-MM-DD).
 */
const lockSheetGeneration = async (client, collectorId, date) => {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1))`,
    [`collection-sheet:${collectorId}:${date}`]
  );
};

/**
 * Genera una planilla de cobro para un cobrador y fecha, reemplazando la existente de forma atómica.
 * Planillas previas se marcan REGENERATED (soft-delete) para preservar historial completo.
 * Incluye lock transaccional para evitar carreras por múltiples submits concurrentes.
 * @param {{ collector_id: string, date: string, filter?: string }} data - Payload de generación.
 * @param {string} adminId - ID del administrador que genera la planilla.
 * @returns {Promise<{ sheet: object, alerts: object }>} Planilla generada más alertas del sistema.
 */
const generate = async (data, adminId) => {
  const { collector_id, date, filter, skip_if_exists } = data;
  const selectedFilter = filter || 'ALL_PENDING';

  // No se permiten planillas para fechas pasadas — no aportan valor operativo y
  // pueden enmascarar errores de digitación al elegir la fecha.
  const today = new Date().toISOString().split('T')[0];
  if (date < today)
    throw { status: 400, message: 'No se puede generar una planilla para una fecha pasada.' };

  // skip_if_exists = generación idempotente: si ya hay ACTIVE para
  // (collector, date) devolvemos { skipped: true, existing_sheet } sin
  // tocar nada. Esto cubre el caso del batch "generar para todos" cuando
  // el admin NO quiere regenerar las existentes, y también cualquier
  // race condition entre múltiples admins/tabs.
  // REGENERATED no cuenta como conflicto: la query filtra solo ACTIVE.
  const result = await withTransaction(async (client) => {
    await lockSheetGeneration(client, collector_id, date);

    // Verificar que el cobrador exista y tenga rol COLLECTOR o SELLER_COLLECTOR
    const collectorCheck = await client.query(
      `SELECT id FROM users WHERE id = $1 AND role IN ('COLLECTOR','SELLER_COLLECTOR') AND status = 'ACTIVE'`,
      [collector_id]
    );
    if (!collectorCheck.rows.length)
      throw { status: 404, message: 'Cobrador no encontrado o inactivo.' };

    if (skip_if_exists) {
      const active = await queries.findActiveByCollectorAndDate(collector_id, date, client);
      if (active) {
        return { skipped: true, existing_sheet: active };
      }
    }

    // Soft-delete: planillas ACTIVE existentes pasan a REGENERATED para preservar historial
    const existing = await client.query(
      `SELECT id FROM collection_sheets
       WHERE collector_id = $1 AND sheet_date = $2::date AND status = 'ACTIVE'`,
      [collector_id, date]
    );
    for (const row of existing.rows) {
      await queries.markSheetAsRegenerated(row.id, client);
    }

    const items = await queries.findInstallmentsForSheet(collector_id, date, selectedFilter, client);

    if (!items.length)
      throw { status: 409, message: 'No hay cuotas para cobrar en el filtro seleccionado. No se generó la planilla.' };

    const sheet = await queries.create({
      collectorId: collector_id,
      date,
      filter: selectedFilter,
      adminId,
    }, client);

    await queries.createDetails(sheet.id, items, client);

    return { sheetId: sheet.id, items };
  });

  // skip_if_exists devolvió un atajo sin crear nada nuevo: el controller
  // se entera por el shape { skipped: true, existing_sheet }.
  if (result.skipped) {
    return { skipped: true, existing_sheet: result.existing_sheet };
  }

  // La transacción ya cerró; leemos detalle completo con JOINs
  const full = await queries.findById(result.sheetId);

  // Alertas: cuotas con next_visit_date vencida (ya incluidas en la planilla, requieren atención)
  const overdueNextVisits = result.items
    .filter(item => item.next_visit_date && item.next_visit_date < date)
    .map(item => ({
      installment_id:      item.installment_id,
      customer_name:       item.customer_name,
      customer_phone:      item.customer_phone,
      customer_address:    item.customer_address,
      next_visit_date:     item.next_visit_date,
      due_date:            item.due_date,
      installment_status:  item.installment_status,
    }));

  // Alertas: clientes activos con cuotas pendientes sin cobrador asignado (alerta global)
  const unassignedCustomers = await queries.findUnassignedCustomersWithPending();

  return {
    sheet: full,
    alerts: {
      overdue_next_visits:  overdueNextVisits,
      unassigned_customers: unassignedCustomers,
    },
  };
};

const getAll = async (filters, requestingUser) => {
  // Cobrador solo ve sus propias planillas
  if (['COLLECTOR','SELLER_COLLECTOR'].includes(requestingUser.role))
    filters = { ...filters, collectorId: requestingUser.id, includeRegenerated: false };
  // includeRegenerated solo aplica para Admin (auditoría de planillas regeneradas)
  if (requestingUser.role !== 'ADMIN')
    filters = { ...filters, includeRegenerated: false };
  return queries.findAll(filters);
};

const getById = async (id, requestingUser) => {
  const sheet = await queries.findById(id);
  if (!sheet) throw { status: 404, message: 'Planilla no encontrada.' };

  if (['COLLECTOR','SELLER_COLLECTOR'].includes(requestingUser.role)) {
    // Cobrador no puede ver planillas REGENERATED (solo Admin las usa para auditoría)
    if (sheet.status === 'REGENERATED')
      throw { status: 403, message: 'No tenés acceso a esta planilla.' };
    // Cobrador solo puede ver sus propias planillas
    if (sheet.collector_id !== requestingUser.id)
      throw { status: 403, message: 'No tenés acceso a esta planilla.' };
  }

  return sheet;
};

module.exports = { generate, getAll, getById };
