const queries        = require('./businessDays.queries');
const csQueries      = require('../cashSessions/cashSessions.queries');
const { withTransaction } = require('../../utils/transaction');

const getById = async (id) => {
  const day = await queries.findById(id);
  if (!day) throw { status: 404, message: 'Jornada no encontrada.' };
  const counts = await queries.countSessionsByStatus(id);
  const sessions = await csQueries.findAll({ businessDayId: id });
  return { ...day, session_counts: counts, sessions };
};

const getAll = async (filters) => queries.findAll(filters);

/**
 * Cierra una jornada (status READY_TO_CLOSE → CLOSED). Manual: requiere
 * supervisor. La transición automática a READY_TO_CLOSE se hace cuando todas
 * las cajas pasan a CLOSED — ver businessDays.queries.maybeTransitionToReadyToClose.
 */
const close = async (id, data, requestingUser) => {
  await withTransaction(async (client) => {
    const day = await queries.lockAndGetById(client, id);
    if (!day) throw { status: 404, message: 'Jornada no encontrada.' };
    if (day.status !== 'READY_TO_CLOSE')
      throw {
        status: 409,
        message: `La jornada está en ${day.status}; solo se cierran las que están READY_TO_CLOSE.`,
      };
    const closed = await queries.close(client, id, {
      closedBy:     requestingUser.id,
      observations: data?.observations,
    });
    if (!closed) throw { status: 409, message: 'La jornada cambió de estado durante el cierre.' };
  });
  return queries.findById(id);
};

/**
 * IMP-5: cierra a la fuerza una jornada con cajas PENDING_RECONCILIATION (que
 * de otra forma nunca llegaría a READY_TO_CLOSE → CLOSED). Requiere reason
 * obligatorio para auditoría. Las cajas PENDING NO se modifican — quedan
 * abiertas como deuda operativa para que el supervisor las reconcilie luego.
 *
 * El motivo se concatena en observations con un prefijo identificable.
 */
const forceClose = async (id, data, requestingUser) => {
  const reason = (data?.reason || '').trim();
  if (!reason)
    throw { status: 422, message: 'reason es obligatorio para forzar el cierre de una jornada.' };

  await withTransaction(async (client) => {
    const day = await queries.lockAndGetById(client, id);
    if (!day) throw { status: 404, message: 'Jornada no encontrada.' };
    if (!['OPEN','READY_TO_CLOSE'].includes(day.status))
      throw { status: 409, message: `La jornada está en ${day.status}; solo se fuerzan cierres desde OPEN o READY_TO_CLOSE.` };

    const counts = await queries.countSessionsByStatus(id, client);
    // Si NO hay cajas PENDING, este endpoint no es necesario — el supervisor
    // debe usar el cierre normal (close). Bloqueamos para no normalizar el
    // uso de force-close cuando hay un camino limpio.
    if (counts.pending_count === 0 && counts.open_count === 0)
      throw { status: 409, message: 'No hay cajas OPEN ni PENDING. Usá el cierre normal (POST /:id/close).' };

    const obsLine = `[FORCE-CLOSE] ${reason} (${counts.open_count} OPEN, ${counts.pending_count} PENDING)`;
    const merged  = day.observations ? `${day.observations}\n${obsLine}` : obsLine;

    const closed = await queries.forceClose(client, id, {
      closedBy:     requestingUser.id,
      observations: merged,
    });
    if (!closed) throw { status: 409, message: 'La jornada cambió de estado durante el force-close.' };
  });
  return queries.findById(id);
};

const audit = async (id, data, requestingUser) => {
  await withTransaction(async (client) => {
    const day = await queries.lockAndGetById(client, id);
    if (!day) throw { status: 404, message: 'Jornada no encontrada.' };
    if (day.status !== 'CLOSED')
      throw {
        status: 409,
        message: `La jornada está en ${day.status}; solo se auditan las CLOSED.`,
      };
    const ok = await queries.audit(client, id, {
      auditedBy:    requestingUser.id,
      observations: data?.observations,
    });
    if (!ok) throw { status: 409, message: 'La jornada cambió de estado durante la auditoría.' };
  });
  return queries.findById(id);
};

module.exports = { getById, getAll, close, forceClose, audit };
