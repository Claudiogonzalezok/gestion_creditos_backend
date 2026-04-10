const pool    = require('../../config/db');
const queries = require('./collections.queries');

const generate = async (data, adminId) => {
  const { collector_id, date, filter } = data;

  // Verificar que el cobrador exista y tenga rol COLLECTOR
  const collectorCheck = await pool.query(
    `SELECT id FROM users WHERE id = $1 AND role = 'COLLECTOR' AND status = 'ACTIVE'`,
    [collector_id]
  );
  if (!collectorCheck.rows.length)
    throw { status: 404, message: 'Cobrador no encontrado o inactivo.' };

  const items = await queries.findInstallmentsForSheet(collector_id, date, filter || 'ALL_PENDING');

  const sheet = await queries.create({
    collectorId: collector_id,
    date,
    filter: filter || 'ALL_PENDING',
    adminId,
  });

  await queries.createDetails(sheet.id, items);

  return {
    ...sheet,
    total_items: items.length,
    items,
    warning: items.length === 0
      ? 'No se encontraron cuotas para el cobrador en el filtro seleccionado.'
      : undefined,
  };
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
