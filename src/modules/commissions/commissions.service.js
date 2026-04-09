const pool    = require('../../config/db');
const queries = require('./commissions.queries');
const { withTransaction } = require('../../utils/transaction');
const { getWeekBounds }   = require('../../utils/creditCalculator');

// ── Consultas de comisiones ───────────────────────────────────

const getCommissions = async (filters, requestingUser) => {
  if (requestingUser.role !== 'ADMIN')
    filters = { ...filters, userId: requestingUser.id };
  return queries.findCommissions(filters);
};

// ── Sueldo fijo ───────────────────────────────────────────────

const getSalary = async (userId) => {
  // Verificar que el usuario exista y sea COLLECTOR
  const check = await pool.query(
    `SELECT id FROM users WHERE id = $1 AND role = 'COLLECTOR' AND status = 'ACTIVE'`,
    [userId]
  );
  if (!check.rows.length)
    throw { status: 404, message: 'Cobrador no encontrado o inactivo.' };

  const salary = await queries.findSalary(userId);
  return salary || { user_id: userId, weekly_amount: 0, active: false };
};

const setSalary = async (userId, weeklyAmount) => {
  const check = await pool.query(
    `SELECT id FROM users WHERE id = $1 AND role = 'COLLECTOR' AND status = 'ACTIVE'`,
    [userId]
  );
  if (!check.rows.length)
    throw { status: 404, message: 'Cobrador no encontrado o inactivo.' };

  const existing = await queries.findSalary(userId);
  if (existing) return queries.updateSalary(existing.id, weeklyAmount);
  return queries.createSalary(userId, weeklyAmount);
};

// ── Resumen semanal ───────────────────────────────────────────

const getWeeklySummary = async (date) => {
  const { week_start, week_end } = getWeekBounds(date ? new Date(date) : new Date());
  const rows = await queries.getWeeklySummary(week_start, week_end);
  return { week_start, week_end, employees: rows };
};

// ── Liquidación ───────────────────────────────────────────────

const liquidate = async (data, adminId) => {
  const { user_id, payment_method, transfer_reference } = data;

  const { week_start, week_end } = getWeekBounds(new Date());

  // Verificar usuario
  const userCheck = await pool.query(
    `SELECT id, role FROM users WHERE id = $1 AND status = 'ACTIVE'`,
    [user_id]
  );
  if (!userCheck.rows.length)
    throw { status: 404, message: 'Usuario no encontrado o inactivo.' };
  const user = userCheck.rows[0];
  if (!['SELLER','COLLECTOR'].includes(user.role))
    throw { status: 409, message: 'Solo se pueden liquidar Vendedores y Cobradores.' };

  const commissionsTotal = await queries.getPendingTotal(user_id, week_start, week_end);
  const salary = await queries.findSalary(user_id);
  const salaryAmount = salary ? parseFloat(salary.weekly_amount) : 0;
  const totalNet = commissionsTotal + salaryAmount;

  if (totalNet <= 0)
    throw { status: 409, message: `El total neto es $${totalNet.toFixed(2)}. No hay monto positivo a liquidar.` };

  return withTransaction(async (client) => {
    const pendingIds = await queries.getPendingIds(client, user_id, week_start, week_end);
    await queries.markCommissionsPaid(client, pendingIds);

    const liquidation = await queries.createLiquidation(client, {
      userId: user_id,
      weekStart: week_start,
      weekEnd: week_end,
      commissionsTotal,
      salaryAmount,
      totalPaid: totalNet,
      paymentMethod: payment_method,
      transferReference: transfer_reference,
      paidBy: adminId,
    });

    return liquidation;
  });
};

const getLiquidations = async (filters, requestingUser) => {
  if (requestingUser.role !== 'ADMIN')
    filters = { ...filters, userId: requestingUser.id };
  return queries.findLiquidations(filters);
};

module.exports = {
  getCommissions, getSalary, setSalary, getWeeklySummary, liquidate, getLiquidations,
};
