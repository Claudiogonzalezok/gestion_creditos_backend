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
  const check = await pool.query(
    `SELECT id FROM users WHERE id = $1 AND role IN ('SELLER','COLLECTOR','SELLER_COLLECTOR') AND status = 'ACTIVE'`,
    [userId]
  );
  if (!check.rows.length)
    throw { status: 404, message: 'Usuario no encontrado o inactivo.' };

  const salary = await queries.findSalary(userId);
  return salary || { user_id: userId, weekly_amount: 0, active: false };
};

const setSalary = async (userId, weeklyAmount) => {
  const check = await pool.query(
    `SELECT id FROM users WHERE id = $1 AND role IN ('SELLER','COLLECTOR','SELLER_COLLECTOR') AND status = 'ACTIVE'`,
    [userId]
  );
  if (!check.rows.length)
    throw { status: 404, message: 'Usuario no encontrado o inactivo.' };

  const existing = await queries.findSalary(userId);
  if (existing) return queries.updateSalary(existing.id, weeklyAmount);
  return queries.createSalary(userId, weeklyAmount);
};

// ── Resumen semanal ───────────────────────────────────────────

const getWeeklySummary = async () => {
  const rows = await queries.getWeeklySummary();
  return { employees: rows };
};

// ── Liquidación ───────────────────────────────────────────────

const liquidate = async (data, adminId) => {
  const { user_id, payment_method, transfer_reference } = data;

  // Verificar usuario
  const userCheck = await pool.query(
    `SELECT id, role FROM users WHERE id = $1 AND status = 'ACTIVE'`,
    [user_id]
  );
  if (!userCheck.rows.length)
    throw { status: 404, message: 'Usuario no encontrado o inactivo.' };
  const user = userCheck.rows[0];
  if (!['SELLER','COLLECTOR','SELLER_COLLECTOR'].includes(user.role))
    throw { status: 409, message: 'Solo se pueden liquidar Vendedores y Cobradores.' };

  // Pre-check rápido fuera de la transacción para fallo temprano
  const salaryRecord = await queries.findSalary(user_id);
  const salaryAmount = salaryRecord ? parseFloat(salaryRecord.weekly_amount) : 0;
  const preTotal = await queries.getPendingTotal(user_id);
  if (preTotal + salaryAmount <= 0)
    throw { status: 409, message: `El total neto es $${(preTotal + salaryAmount).toFixed(2)}. No hay monto positivo a liquidar.` };

  return withTransaction(async (client) => {
    const pendingRows = await queries.getPendingIds(client, user_id);
    const pendingIds  = pendingRows.map(r => r.id);

    // Total calculado dentro de la transacción para evitar race conditions
    const commissionsTotal = pendingRows.reduce((sum, r) => sum + parseFloat(r.amount), 0);
    const totalNet = commissionsTotal + salaryAmount;

    if (totalNet <= 0)
      throw { status: 409, message: `El total neto es $${totalNet.toFixed(2)}. No hay monto positivo a liquidar.` };

    // Rango real de semanas que cubre esta liquidación
    const weekStart = pendingRows.length
      ? pendingRows.reduce((min, r) => r.week_start < min ? r.week_start : min, pendingRows[0].week_start)
      : getWeekBounds().week_start;
    const weekEnd = pendingRows.length
      ? pendingRows.reduce((max, r) => r.week_end > max ? r.week_end : max, pendingRows[0].week_end)
      : getWeekBounds().week_end;

    await queries.markCommissionsPaid(client, pendingIds);

    return queries.createLiquidation(client, {
      userId: user_id,
      weekStart,
      weekEnd,
      commissionsTotal,
      salaryAmount,
      totalPaid: totalNet,
      paymentMethod: payment_method,
      transferReference: transfer_reference,
      paidBy: adminId,
    });
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
