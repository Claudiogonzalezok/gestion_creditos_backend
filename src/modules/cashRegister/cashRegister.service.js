const pool    = require('../../config/db');
const queries = require('./cashRegister.queries');
const { localDate } = require('../../utils/date');

/**
 * Determina la fecha de la jornada comercial activa.
 * Busca la fecha más reciente con actividad sin cierre de caja.
 * Si no hay jornada sin cerrar en los últimos 14 días, retorna el día de hoy como fallback.
 * @returns {Promise<string>} Fecha YYYY-MM-DD de la jornada activa.
 */
const getActiveJornadaDate = async () => {
  const today = localDate();
  const jornadaDate = await queries.findUnclosedJornadaDate(today);
  return jornadaDate || today;
};

const getDashboard = async (date) => {
  const target = date || (await getActiveJornadaDate());
  const [data, closed] = await Promise.all([
    queries.getDashboard(target),
    queries.findByDate(target),
  ]);
  return {
    date:                target,
    is_closed:           !!closed,
    cash_amount:         data.cash_amount,
    transfer_amount:     data.transfer_amount,
    total_collected:     data.total_collected,
    total_outflows:       data.total_outflows,
    net_balance:         data.net_balance,
    approved_count:      data.approved_count,
    pending_count:       data.pending_count,
    pending_amount:      data.pending_amount,
    down_payments_total: data.down_payments_total,
    down_payments_count: data.down_payments_count,
  };
};

const close = async (data, adminId) => {
  const today        = localDate();
  const registerDate = data.register_date || (await getActiveJornadaDate());

  if (registerDate > today)
    throw { status: 422, message: 'No se puede cerrar una caja de fecha futura.' };

  const existing = await queries.findByDate(registerDate);
  if (existing)
    throw { status: 409, message: `Ya existe un cierre de caja para el ${registerDate}.` };

  // El chequeo de pre-cargas pendientes aplica siempre que la jornada tenga cobros
  // sin aprobar, incluyendo el caso post-medianoche (registerDate = ayer).
  if (!data.force) {
    const pending = await queries.getPendingPaymentsToday(registerDate);
    if (pending.count > 0)
      throw { status: 409, message: `Hay ${pending.count} pre-carga(s) pendiente(s) de aprobación por $${pending.amount}. Aprobá o rechazá antes de cerrar, o enviá force: true para cerrar igual.`, pending_payments: pending };
  }

  const totals         = await queries.getDailyTotals(registerDate);
  const cashAmount     = totals.cash_amount;        // neto: ingresos_efec - egresos_efec
  const transferAmount = totals.transfer_amount;    // neto: ingresos_transf - egresos_transf
  const totalCollected = totals.gross_cash + totals.gross_transfer; // ingresos brutos (dato contable)
  const totalOutflows  = totals.total_outflows;
  const declaredCash   = parseFloat(data.declared_cash);
  const difference     = declaredCash - cashAmount; // arqueo real sobre efectivo neto

  let differenceStatus = 'EXACT';
  if (difference > 0)  differenceStatus = 'SURPLUS';
  if (difference < 0)  differenceStatus = 'SHORTAGE';

  // Transacción: crear cierre y vincular liquidaciones de la fecha
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const register = await queries.create(client, {
      registerDate,
      cashAmount,
      transferAmount,
      totalCollected,
      totalOutflows,
      declaredCash,
      difference,
      differenceStatus,
      observations:     data.observations,
      closedBy:         adminId,
    });

    await queries.linkLiquidations(client, register.id, registerDate);

    await client.query('COMMIT');
    return register;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const getPreClose = async (date) => {
  const target = date || (await getActiveJornadaDate());
  const data   = await queries.getPreClose(target);
  return {
    date: target,
    ingresos: {
      cobros_efectivo:        data.cobros_efectivo,
      cobros_transferencia:   data.cobros_transferencia,
      enganches_efectivo:     data.enganches_efectivo,
      enganches_transferencia: data.enganches_transferencia,
      total_bruto:            data.total_bruto,
    },
    egresos: {
      gastos_efectivo:        data.gastos_efectivo,
      gastos_transferencia:   data.gastos_transferencia,
      comisiones_efectivo:    data.comisiones_efectivo,
      comisiones_transferencia: data.comisiones_transferencia,
      total:                  data.total_egresos,
    },
    efectivo: {
      esperado: data.efectivo_esperado,
    },
    transferencias: {
      esperado: data.transferencia_esperada,
    },
    pendientes: {
      count:  data.pendientes_count,
      amount: data.pendientes_amount,
    },
  };
};

const getAll = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const register = await queries.findById(id);
  if (!register) throw { status: 404, message: 'Cierre de caja no encontrado.' };
  return register;
};

/**
 * Registra una conversión interna entre efectivo y transferencia para la jornada activa.
 * @param {object} data - Datos de conversión enviados por el cliente.
 * @param {string} adminId - Usuario ADMIN que ejecuta la conversión.
 * @returns {Promise<object>} Conversión creada.
 */
const createConversion = async (data, adminId) => {
  const registerDate = data.register_date || (await getActiveJornadaDate());

  const existing = await queries.findByDate(registerDate);
  if (existing)
    throw { status: 409, message: `La caja del ${registerDate} ya está cerrada. No se pueden registrar conversiones.` };

  const amount = parseFloat(data.amount);
  if (!Number.isFinite(amount) || amount <= 0)
    throw { status: 422, message: 'El monto de conversión debe ser mayor a 0.' };

  const sourceMethod = data.source_method;
  const targetMethod = sourceMethod === 'CASH' ? 'TRANSFER' : 'CASH';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const conversion = await queries.createConversion(client, {
      registerDate,
      criteria: data.criteria,
      sourceMethod,
      targetMethod,
      amount,
      notes: data.notes,
      createdBy: adminId,
    });
    await client.query('COMMIT');
    return conversion;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { getDashboard, getPreClose, close, getAll, getById, getActiveJornadaDate, createConversion };
