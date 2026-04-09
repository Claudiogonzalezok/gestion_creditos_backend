const queries = require('./cashRegister.queries');

const getDashboard = async () => {
  const today = new Date().toISOString().split('T')[0];
  const data  = await queries.getDashboard(today);
  return {
    date:           today,
    total_cash:     parseFloat(data.total_cash),
    total_transfer: parseFloat(data.total_transfer),
    total_approved: parseFloat(data.total_approved),
    approved_count: parseInt(data.approved_count),
    pending_count:  parseInt(data.pending_count),
  };
};

const close = async (data, adminId) => {
  const today = new Date().toISOString().split('T')[0];

  // Un solo cierre por día
  const existing = await queries.findByDate(today);
  if (existing)
    throw { status: 409, message: 'Ya existe un cierre de caja para hoy.' };

  const totalCash     = await queries.getDailyCashTotal(today);
  const totalTransfer = await queries.getDailyTransferTotal(today);
  const totalApproved = totalCash + totalTransfer;
  const declaredCash  = parseFloat(data.declared_cash);
  const difference    = declaredCash - totalCash;

  const pendingCount  = await queries.getPendingPaymentsCount();

  let status = 'BALANCED';
  if (difference > 0)  status = 'SURPLUS';
  if (difference < 0)  status = 'SHORTAGE';

  return queries.create({
    registerDate:         today,
    totalCash,
    totalTransfer,
    totalApproved,
    declaredCash,
    cashDifference:       difference,
    status,
    pendingPaymentsCount: pendingCount,
    observations:         data.observations,
    closedBy:             adminId,
  });
};

const getAll = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const register = await queries.findById(id);
  if (!register) throw { status: 404, message: 'Cierre de caja no encontrado.' };
  return register;
};

module.exports = { getDashboard, close, getAll, getById };
