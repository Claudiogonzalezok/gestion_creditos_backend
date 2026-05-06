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
 * Incluye lock transaccional para evitar carreras por múltiples submits concurrentes.
 * @param {{ collector_id: string, date: string, filter?: string }} data - Payload de generación.
 * @param {string} adminId - ID del administrador que genera la planilla.
 * @returns {Promise<object>} Planilla generada con detalle de cuotas incluidas.
 */
const generate = async (data, adminId) => {
  const { collector_id, date, filter } = data;
  const selectedFilter = filter || 'ALL_PENDING';

  return withTransaction(async (client) => {
    await lockSheetGeneration(client, collector_id, date);

    // Verificar que el cobrador exista y tenga rol COLLECTOR o SELLER_COLLECTOR
    const collectorCheck = await client.query(
      `SELECT id FROM users WHERE id = $1 AND role IN ('COLLECTOR','SELLER_COLLECTOR') AND status = 'ACTIVE'`,
      [collector_id]
    );
    if (!collectorCheck.rows.length)
      throw { status: 404, message: 'Cobrador no encontrado o inactivo.' };

    // Si ya existen planillas para ese cobrador en esa fecha, eliminarlas todas
    const existing = await client.query(
      `SELECT id FROM collection_sheets
       WHERE collector_id = $1 AND sheet_date = $2::date`,
      [collector_id, date]
    );
    if (existing.rows.length) {
      const ids = existing.rows.map(r => r.id);
      await client.query(
        `DELETE FROM collection_sheet_details WHERE sheet_id = ANY($1::uuid[])`,
        [ids]
      );
      await client.query(
        `DELETE FROM collection_sheets WHERE id = ANY($1::uuid[])`,
        [ids]
      );
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

    return {
      ...sheet,
      total_items: items.length,
      items,
    };
  });
};

const getAll = async (filters, requestingUser) => {
  // Cobrador solo ve sus propias planillas
  if (['COLLECTOR','SELLER_COLLECTOR'].includes(requestingUser.role))
    filters = { ...filters, collectorId: requestingUser.id };
  return queries.findAll(filters);
};

const getById = async (id, requestingUser) => {
  const sheet = await queries.findById(id);
  if (!sheet) throw { status: 404, message: 'Planilla no encontrada.' };

  // Cobrador (y vendedor-cobrador) solo puede ver sus propias planillas
  if (['COLLECTOR','SELLER_COLLECTOR'].includes(requestingUser.role) && sheet.collector_id !== requestingUser.id)
    throw { status: 403, message: 'No tenés acceso a esta planilla.' };

  return sheet;
};

module.exports = { generate, getAll, getById };
