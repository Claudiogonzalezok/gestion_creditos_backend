const queries = require('./collections.queries');
const { withTransaction } = require('../../utils/transaction');
const { localDate }       = require('../../utils/date');

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
 * Valida que la fecha no sea pasada. Compartida entre generación individual y batch.
 * Usa localDate (TZ del proyecto) y NO toISOString() para evitar que ART vs UTC
 * corra el "hoy" un día y bloquee generaciones legítimas cerca de medianoche.
 * @param {string} date - Fecha objetivo (YYYY-MM-DD).
 */
const assertDateNotInPast = (date) => {
  const today = localDate();
  if (date < today)
    throw { status: 400, message: 'No se puede generar una planilla para una fecha pasada.' };
};

/**
 * Ejecuta la transacción de generación para UN cobrador: lock, validación de
 * cobrador, soft-delete de planilla previa y creación de la nueva. No calcula
 * alertas — eso se resuelve afuera (una vez en `generate`, compartido en `generateBatch`).
 * @param {string} collectorId
 * @param {string} date
 * @param {string} selectedFilter
 * @param {boolean} skipIfExists
 * @param {string} adminId
 * @returns {Promise<{ skipped: true, existing_sheet: object } | { sheetId: string, items: Array }>}
 */
const generateSheetTransaction = async (collectorId, date, selectedFilter, skipIfExists, adminId) => {
  return withTransaction(async (client) => {
    await lockSheetGeneration(client, collectorId, date);

    // Verificar que el cobrador exista y tenga rol COLLECTOR o SELLER_COLLECTOR
    const collectorCheck = await client.query(
      `SELECT id FROM users WHERE id = $1 AND role IN ('COLLECTOR','SELLER_COLLECTOR') AND status = 'ACTIVE'`,
      [collectorId]
    );
    if (!collectorCheck.rows.length)
      throw { status: 404, message: 'Cobrador no encontrado o inactivo.' };

    // skip_if_exists = generación idempotente: si ya hay ACTIVE para
    // (collector, date) devolvemos { skipped: true, existing_sheet } sin
    // tocar nada. Esto cubre el caso del batch "generar para todos" cuando
    // el admin NO quiere regenerar las existentes, y también cualquier
    // race condition entre múltiples admins/tabs.
    // REGENERATED no cuenta como conflicto: la query filtra solo ACTIVE.
    if (skipIfExists) {
      const active = await queries.findActiveByCollectorAndDate(collectorId, date, client);
      if (active) {
        return { skipped: true, existing_sheet: active };
      }
    }

    // Soft-delete: planillas ACTIVE existentes pasan a REGENERATED para preservar historial
    const existing = await client.query(
      `SELECT id FROM collection_sheets
       WHERE collector_id = $1 AND sheet_date = $2::date AND status = 'ACTIVE'`,
      [collectorId, date]
    );
    for (const row of existing.rows) {
      await queries.markSheetAsRegenerated(row.id, client);
    }

    const items = await queries.findInstallmentsForSheet(collectorId, date, selectedFilter, client);

    if (!items.length)
      throw { status: 409, message: 'No hay cuotas para cobrar en el filtro seleccionado. No se generó la planilla.' };

    const sheet = await queries.create({
      collectorId,
      date,
      filter: selectedFilter,
      adminId,
    }, client);

    await queries.createDetails(sheet.id, items, client);

    return { sheetId: sheet.id, items };
  });
};

/**
 * Arma las alertas de "próxima visita vencida" a partir de los items
 * incluidos en la planilla recién generada.
 * @param {Array} items - Items devueltos por generateSheetTransaction.
 * @param {string} date - Fecha de la planilla.
 * @returns {Array}
 */
const buildOverdueNextVisitsAlert = (items, date) =>
  items
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

/**
 * Genera una planilla de cobro para un cobrador y fecha, reemplazando la existente de forma atómica.
 * @param {{ collector_id: string, date: string, filter?: string }} data - Payload de generación.
 * @param {string} adminId - ID del administrador que genera la planilla.
 * @returns {Promise<{ sheet: object, alerts: object }>} Planilla generada más alertas del sistema.
 */
const generate = async (data, adminId) => {
  const { collector_id, date, filter, skip_if_exists } = data;
  const selectedFilter = filter || 'ALL_PENDING';
  assertDateNotInPast(date);

  const result = await generateSheetTransaction(collector_id, date, selectedFilter, skip_if_exists, adminId);

  // skip_if_exists devolvió un atajo sin crear nada nuevo: el controller
  // se entera por el shape { skipped: true, existing_sheet }.
  if (result.skipped) {
    return { skipped: true, existing_sheet: result.existing_sheet };
  }

  // La transacción ya cerró; leemos detalle completo con JOINs
  const full = await queries.findById(result.sheetId);

  return {
    sheet: full,
    alerts: {
      overdue_next_visits:  buildOverdueNextVisitsAlert(result.items, date),
      unassigned_customers: await queries.findUnassignedCustomersWithPending(),
    },
  };
};

/**
 * Genera planillas para múltiples cobradores en una sola operación.
 * A diferencia de N requests individuales (uno por cobrador), calcula UNA
 * sola vez la alerta global "clientes sin cobrador asignado" — esa query es
 * independiente del collector_id, así que repetirla N veces era trabajo
 * redundante sobre la base. Cada cobrador sigue corriendo en su propia
 * transacción con su propio lock: el fallo de uno no aborta a los demás.
 * @param {{ collector_ids: string[], date: string, filter?: string, skip_if_exists?: boolean }} data
 * @param {string} adminId - ID del administrador que genera el batch.
 * @returns {Promise<{ results: Array }>} Un resultado por cobrador, en el mismo orden recibido.
 */
const generateBatch = async (data, adminId) => {
  const { collector_ids, date, filter, skip_if_exists } = data;
  const selectedFilter = filter || 'ALL_PENDING';
  assertDateNotInPast(date);

  const unassignedCustomers = await queries.findUnassignedCustomersWithPending();

  const results = [];
  for (const collectorId of collector_ids) {
    try {
      const result = await generateSheetTransaction(collectorId, date, selectedFilter, skip_if_exists, adminId);

      if (result.skipped) {
        results.push({ collector_id: collectorId, skipped: true, existing_sheet: result.existing_sheet });
        continue;
      }

      results.push({
        collector_id: collectorId,
        sheet: await queries.findById(result.sheetId),
        alerts: {
          overdue_next_visits:  buildOverdueNextVisitsAlert(result.items, date),
          unassigned_customers: unassignedCustomers,
        },
      });
    } catch (err) {
      results.push({
        collector_id: collectorId,
        error: { status: err.status || 500, message: err.message || 'Error inesperado al generar la planilla.' },
      });
    }
  }

  return { results };
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

/**
 * Cierra una planilla del día (status='ACTIVE' → 'CLOSED').
 * Solo Admin. La planilla cerrada es terminal: no se puede reabrir ni
 * editar management_status. Sirve para arqueo y cierre operativo.
 * @param {string} id
 * @param {string} adminId
 */
const close = async (id, adminId) => {
  const sheet = await queries.findById(id);
  if (!sheet) throw { status: 404, message: 'Planilla no encontrada.' };
  if (sheet.status !== 'ACTIVE')
    throw { status: 409, message: `Solo se pueden cerrar planillas en estado ACTIVE (actual: ${sheet.status}).` };

  const closed = await queries.closeSheet(id, adminId);
  if (!closed)
    throw { status: 409, message: 'La planilla cambió de estado durante la operación. Reintentá.' };
  return await queries.findById(id);
};

/**
 * Cancela una planilla del día (status='ACTIVE' → 'CANCELLED').
 * Útil cuando la planilla se generó por error y no debe trabajarse.
 * @param {string} id
 */
const cancel = async (id) => {
  const sheet = await queries.findById(id);
  if (!sheet) throw { status: 404, message: 'Planilla no encontrada.' };
  if (sheet.status !== 'ACTIVE')
    throw { status: 409, message: `Solo se pueden cancelar planillas en estado ACTIVE (actual: ${sheet.status}).` };

  const cancelled = await queries.cancelSheet(id);
  if (!cancelled)
    throw { status: 409, message: 'La planilla cambió de estado durante la operación. Reintentá.' };
  return await queries.findById(id);
};

/**
 * Marca una planilla ACTIVE como enviada al cobrador.
 * Solo el Admin puede realizar esta acción.
 * @param {string} id - ID de la planilla.
 * @param {{ id: string, role: string }} requestingUser - Usuario que realiza la acción.
 * @returns {Promise<{ id, sent_at }>}
 */
const send = async (id, requestingUser) => {
  const sheet = await queries.findById(id);
  if (!sheet) throw { status: 404, message: 'Planilla no encontrada.' };
  if (sheet.status !== 'ACTIVE')
    throw { status: 409, message: 'Solo se puede marcar como enviada una planilla activa.' };
  if (sheet.sent_at)
    throw { status: 409, message: 'La planilla ya fue marcada como enviada.' };
  const updated = await queries.markAsSent(id, requestingUser.id);
  if (!updated) throw { status: 409, message: 'No se pudo marcar la planilla como enviada.' };
  return updated;
};

module.exports = { generate, generateBatch, getAll, getById, close, cancel, send };
