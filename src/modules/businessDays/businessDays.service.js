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

module.exports = { getById, getAll, close, audit };
