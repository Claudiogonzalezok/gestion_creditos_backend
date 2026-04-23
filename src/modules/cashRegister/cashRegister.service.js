const pool    = require('../../config/db');
const queries = require('./cashRegister.queries');
const { localDate } = require('../../utils/date');

const getDashboard = async () => {
  const today = localDate();
  const data  = await queries.getDashboard(today);
  return {
    date:                today,
    cash_amount:         data.cash_amount,
    transfer_amount:     data.transfer_amount,
    total_collected:     data.total_collected,
    total_egreses:       data.total_egreses,
    net_balance:         data.net_balance,
    approved_count:      data.approved_count,
    pending_count:       data.pending_count,
    pending_amount:      data.pending_amount,
    down_payments_total: data.down_payments_total,
    down_payments_count: data.down_payments_count,
  };
};

const close = async (data, adminId) => {
  const today = localDate();

  const existing = await queries.findByDate(today);
  if (existing)
    throw { status: 409, message: 'Ya existe un cierre de caja para hoy.' };

  if (!data.force) {
    const pending = await queries.getPendingPaymentsToday(today);
    if (pending.count > 0)
      throw { status: 409, message: `Hay ${pending.count} pre-carga(s) pendiente(s) de aprobación por $${pending.amount}. Aprobá o rechazá antes de cerrar, o enviá force: true para cerrar igual.`, pending_payments: pending };
  }

  const totals       = await queries.getDailyTotals(today);
  const cashAmount   = totals.cash_amount;
  const transferAmount = totals.transfer_amount;
  const totalCollected = cashAmount + transferAmount;
  const totalEgreses = totals.total_egreses;
  const declaredCash = parseFloat(data.declared_cash);
  const difference   = declaredCash - cashAmount;

  let differenceStatus = 'EXACT';
  if (difference > 0)  differenceStatus = 'SURPLUS';
  if (difference < 0)  differenceStatus = 'SHORTAGE';

  // Transacción: crear cierre y vincular liquidaciones del día
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const register = await queries.create(client, {
      registerDate:     today,
      cashAmount,
      transferAmount,
      totalCollected,
      totalEgreses,
      declaredCash,
      difference,
      differenceStatus,
      observations:     data.observations,
      closedBy:         adminId,
    });

    await queries.linkLiquidations(client, register.id, today);

    await client.query('COMMIT');
    return register;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const getAll = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const register = await queries.findById(id);
  if (!register) throw { status: 404, message: 'Cierre de caja no encontrado.' };
  return register;
};

module.exports = { getDashboard, close, getAll, getById };
