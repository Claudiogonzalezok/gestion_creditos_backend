const pool            = require('../../config/db');
const queries         = require('./installments.queries');
const paymentsQueries = require('../payments/payments.queries');
const paymentsService = require('../payments/payments.service');
const { getValue }    = require('../systemConfig/systemConfig.queries');

const getAll = async (filters, requestingUser) => {
  if (['COLLECTOR','SELLER_COLLECTOR'].includes(requestingUser.role))
    filters = { ...filters, collector_id: requestingUser.id };
  return queries.findAll(filters);
};

const getById = async (id) => {
  const inst = await queries.findById(id);
  if (!inst) throw { status: 404, message: 'Cuota no encontrada.' };
  return inst;
};

const applyPenalty = async (id, penaltyAmount) => {
  const inst = await queries.findById(id);
  if (!inst) throw { status: 404, message: 'Cuota no encontrada.' };
  if (!['OVERDUE'].includes(inst.status))
    throw { status: 409, message: `No se puede aplicar mora a una cuota en estado ${inst.status}. Solo se aplica mora a cuotas OVERDUE.` };

  const maxRate      = parseFloat(await getValue('penalty_max_rate') || '0.50');
  const original     = parseFloat(inst.amount_due) - parseFloat(inst.penalty_amount);
  const maxPenalty   = original * maxRate;
  const currentPenalty = parseFloat(inst.penalty_amount);

  if (currentPenalty >= maxPenalty)
    throw { status: 409, message: `La mora ya alcanzó el tope máximo (${maxRate * 100}% del monto original).` };

  const applicable = Math.min(penaltyAmount, maxPenalty - currentPenalty);
  return queries.applyPenalty(id, applicable);
};

const waivePenalty = async (id) => {
  const inst = await queries.findById(id);
  if (!inst) throw { status: 404, message: 'Cuota no encontrada.' };
  // Política defensiva: si la cuota ya está cancelada, condonar mora generaría
  // un saldo a favor del cliente que el modelo actual no soporta (no hay tabla
  // de créditos a cliente / refund). Forzamos a usar reversión en su lugar.
  if (inst.status === 'PAID')
    throw {
      status:  409,
      message: 'La cuota ya fue cancelada. La condonación retroactiva generaría saldo a favor no soportado por el sistema.',
    };
  if (parseFloat(inst.penalty_amount) === 0)
    throw { status: 409, message: 'Esta cuota no tiene mora aplicada.' };
  const graceDays = parseInt(await getValue('penalty_grace_days') || '3');
  return queries.waivePenalty(id, graceDays);
};

const earlyPay = async (id, paymentMethod, transferReference, adminId) => {
  const inst = await queries.findById(id);
  if (!inst) throw { status: 404, message: 'Cuota no encontrada.' };
  if (inst.status === 'PAID')
    throw { status: 409, message: 'Esta cuota ya fue pagada.' };

  // Verificar que no haya pre-cargas PENDING pendientes de aprobación
  const pendingAmount = await paymentsQueries.getPendingCommittedAmount(id);
  if (pendingAmount > 0)
    throw { status: 409, message: 'Hay pre-cargas pendientes de aprobación para esta cuota. Aprobá o rechazalas antes de aplicar un pago anticipado.' };

  // Saldo real pendiente de la cuota.
  const amountReceived = Math.round((parseFloat(inst.amount_due) - parseFloat(inst.amount_paid)) * 100) / 100;

  // Se delega en el cobro directo del admin, que imputa el ingreso a la caja
  // activa de la jornada (cash_session_id + movimiento contable) y liquida el
  // crédito si corresponde. Antes este flujo insertaba el pago SIN imputarlo a
  // ninguna caja → el dinero quedaba invisible para la contabilidad. Esa
  // divergencia se elimina reutilizando el flujo canónico.
  await paymentsService.adminDirect(
    {
      installment_id:     id,
      amount_received:    amountReceived,
      payment_method:     paymentMethod,
      transfer_reference: transferReference,
      notes:              'Pago anticipado de cuota',
    },
    adminId,
  );

  const updated = await queries.findById(id);
  const creditStatus = await pool.query(
    `SELECT status FROM credits WHERE id = $1`,
    [updated.credit_id],
  );

  return {
    ...updated,
    credit_settled: creditStatus.rows[0]?.status === 'SETTLED',
  };
};

/**
 * Devuelve el log cronológico de gestiones (cobros + intentos) sobre una cuota.
 * COLLECTOR/SELLER_COLLECTOR solo pueden ver cuotas de clientes asignados a ellos;
 * ADMIN accede a cualquier cuota.
 *
 * @param {string} id - ID de la cuota.
 * @param {object} requestingUser - Usuario autenticado.
 */
const getManagementLog = async (id, requestingUser) => {
  const ownerRes = await pool.query(
    `SELECT cu.assigned_collector_id
     FROM installments i
     JOIN credits c    ON c.id  = i.credit_id
     JOIN customers cu ON cu.id = c.customer_id
     WHERE i.id = $1`,
    [id]
  );
  if (!ownerRes.rows.length)
    throw { status: 404, message: 'Cuota no encontrada.' };

  if (['COLLECTOR','SELLER_COLLECTOR'].includes(requestingUser.role)) {
    if (ownerRes.rows[0].assigned_collector_id !== requestingUser.id)
      throw { status: 403, message: 'No tenés acceso a esta cuota.' };
  }

  return queries.findManagementLog(id);
};

module.exports = { getAll, getById, applyPenalty, waivePenalty, earlyPay, getManagementLog };
