const pool    = require('../../config/db');
const queries = require('./cashRegister.queries');

const getDashboard = async () => {
  const today = new Date().toISOString().split('T')[0];
  const data    = await queries.getDashboard(today);
  const egreses = await queries.getDailyEgresesTotal(today);
  return {
    date:                today,
    cash_amount:         data.cash_amount,
    transfer_amount:     data.transfer_amount,
    total_collected:     data.total_collected,
    total_egreses:       egreses,
    approved_count:      data.approved_count,
    pending_count:       data.pending_count,
    down_payments_total: data.down_payments_total,
    down_payments_count: data.down_payments_count,
  };
};

const close = async (data, adminId) => {
  const today = new Date().toISOString().split('T')[0];

  // Un solo cierre por día
  const existing = await queries.findByDate(today);
  if (existing)
    throw { status: 409, message: 'Ya existe un cierre de caja para hoy.' };

  const cashAmount     = await queries.getDailyCashTotal(today);
  const transferAmount = await queries.getDailyTransferTotal(today);
  const totalCollected = cashAmount + transferAmount;
  const totalEgreses   = await queries.getDailyEgresesTotal(today);
  const declaredCash   = parseFloat(data.declared_cash);
  const difference     = declaredCash - cashAmount;

  let differenceStatus = 'BALANCED';
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

const getAll  = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const register = await queries.findById(id);
  if (!register) throw { status: 404, message: 'Cierre de caja no encontrado.' };
  return register;
};

module.exports = { getDashboard, close, getAll, getById };
