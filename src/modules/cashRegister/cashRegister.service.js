const queries = require('./cashRegister.queries');

const getDashboard = async () => {
  const today = new Date().toISOString().split('T')[0];
  const data  = await queries.getDashboard(today);
  return {
    date:            today,
    cash_amount:     parseFloat(data.cash_amount),
    transfer_amount: parseFloat(data.transfer_amount),
    total_collected: parseFloat(data.total_collected),
    approved_count:  parseInt(data.approved_count),
    pending_count:   parseInt(data.pending_count),
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
  const declaredCash   = parseFloat(data.declared_cash);
  const difference     = declaredCash - cashAmount;

  let differenceStatus = 'BALANCED';
  if (difference > 0)  differenceStatus = 'SURPLUS';
  if (difference < 0)  differenceStatus = 'SHORTAGE';

  return queries.create({
    registerDate:     today,
    cashAmount,
    transferAmount,
    totalCollected,
    declaredCash,
    difference,
    differenceStatus,
    observations:     data.observations,
    closedBy:         adminId,
  });
};

const getAll  = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const register = await queries.findById(id);
  if (!register) throw { status: 404, message: 'Cierre de caja no encontrado.' };
  return register;
};

module.exports = { getDashboard, close, getAll, getById };
