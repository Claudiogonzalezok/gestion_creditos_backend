const pool   = require('../../config/db');
const queries = require('./collectionAttempts.queries');

/**
 * Registra un intento de cobranza (NO_PAYMENT o NOT_FOUND).
 * Valida cuota activa, ownership del cobrador y reglas por tipo.
 *
 * Ownership — ETAPA 1 (Opción A):
 *   collector_id = requestingUser.id siempre, incluyendo Admin.
 *   El Admin puede registrar gestiones, pero quedan a su nombre.
 *   Opción B (Admin elige cobrador) queda pendiente para ETAPA futura.
 *
 * @param {object} data - Datos del intento.
 * @param {object} requestingUser - Usuario autenticado.
 * @returns {Promise<object>} Intento registrado.
 */
const create = async (data, requestingUser) => {
  // Verificar que la cuota exista y obtener datos del crédito/cliente
  const instRes = await pool.query(
    `SELECT i.id, i.status AS installment_status,
            c.id AS credit_id, c.status AS credit_status,
            cu.assigned_collector_id
     FROM installments i
     JOIN credits c   ON c.id  = i.credit_id
     JOIN customers cu ON cu.id = c.customer_id
     WHERE i.id = $1`,
    [data.installment_id]
  );
  if (!instRes.rows.length)
    throw { status: 404, message: 'Cuota no encontrada.' };

  const inst = instRes.rows[0];

  if (inst.credit_status !== 'ACTIVE')
    throw { status: 409, message: `No se pueden registrar intentos en un crédito en estado ${inst.credit_status}.` };

  // Validar ownership: cobrador solo puede registrar sobre sus propios clientes
  if (['COLLECTOR', 'SELLER_COLLECTOR'].includes(requestingUser.role)) {
    if (inst.assigned_collector_id !== requestingUser.id)
      throw { status: 403, message: 'No tenés acceso a esta cuota. El cliente no está asignado a tu cartera.' };
  }

  // Reglas por tipo de intento
  if (data.attempt_type === 'NO_PAYMENT') {
    if (!data.reason || !data.reason.trim())
      throw { status: 422, message: 'El motivo es obligatorio para intentos de tipo NO_PAYMENT.' };
    if (!data.next_visit_date)
      throw { status: 422, message: 'La fecha de próxima visita es obligatoria para intentos de tipo NO_PAYMENT.' };
  }

  return queries.create({
    installmentId:  data.installment_id,
    collectorId:    requestingUser.id,
    createdBy:      requestingUser.id,
    attemptType:    data.attempt_type,
    reason:         data.reason,
    nextVisitDate:  data.attempt_type === 'NOT_FOUND' ? null : data.next_visit_date,
    notes:          data.notes,
  });
};

/**
 * Lista intentos con scope por rol.
 * @param {object} filters
 * @param {object} requestingUser
 */
const getAll = async (filters, requestingUser) => {
  if (['COLLECTOR', 'SELLER_COLLECTOR'].includes(requestingUser.role))
    filters = { ...filters, collectorId: requestingUser.id };
  return queries.findAll(filters);
};

/**
 * Obtiene un intento por ID con scope por rol.
 * @param {string} id
 * @param {object} requestingUser
 */
const getById = async (id, requestingUser) => {
  const attempt = await queries.findById(id);
  if (!attempt) throw { status: 404, message: 'Intento de cobranza no encontrado.' };

  if (['COLLECTOR', 'SELLER_COLLECTOR'].includes(requestingUser.role) &&
      attempt.collector_id !== requestingUser.id)
    throw { status: 403, message: 'No tenés acceso a este intento de cobranza.' };

  return attempt;
};

/**
 * Anula un intento de cobranza (supersede pattern). Reglas:
 *   - Solo el cobrador que lo registró puede anularlo (excepto ADMIN).
 *   - Solo el mismo día calendario en que fue registrado.
 *   - No se puede anular un intento ya anulado.
 *   - Nunca se elimina físicamente: queda voided_at / voided_by para auditoría.
 *
 * @param {string} id
 * @param {object} requestingUser
 * @returns {Promise<object>}
 */
const voidAttempt = async (id, requestingUser) => {
  const attempt = await queries.findRawById(id);
  if (!attempt) throw { status: 404, message: 'Intento de cobranza no encontrado.' };

  if (attempt.voided_at)
    throw { status: 409, message: 'Este intento ya fue anulado.' };

  // ADMIN puede anular siempre; cobradores solo lo suyo
  if (requestingUser.role !== 'ADMIN') {
    if (attempt.collector_id !== requestingUser.id)
      throw { status: 403, message: 'Solo el cobrador que registró el intento puede anularlo.' };
  }

  // Solo mismo día calendario (created_at::date = current_date)
  const created = new Date(attempt.created_at);
  const today = new Date();
  const sameDay =
    created.getFullYear() === today.getFullYear() &&
    created.getMonth() === today.getMonth() &&
    created.getDate() === today.getDate();
  if (!sameDay)
    throw { status: 409, message: 'Solo se pueden anular intentos registrados en el día actual.' };

  await queries.markVoided(id, requestingUser.id);
  return queries.findById(id);
};

module.exports = { create, getAll, getById, voidAttempt };
