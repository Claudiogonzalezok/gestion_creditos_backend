// ═══════════════════════════════════════════════════════════════════════════
// @deprecated MÓDULO LEGACY (cashRegister.service)
// ═══════════════════════════════════════════════════════════════════════════
// Mantenido por compat con el dashboard antiguo y los flujos pre-Fase 1+2+3.
// La autoridad operativa pasó a businessDays + cashSessions + cashAccounts.
// NO agregar lógica nueva ni nuevas dependencias acá.
// La excepción es getActiveJornadaDate, que se mantiene exportada (migrada
// internamente al nuevo modelo) porque varios callers viejos la consumen.
// Eliminación prevista en feat/cash-system-cleanup.
// ═══════════════════════════════════════════════════════════════════════════

const pool = require("../../config/db");
const queries = require("./cashRegister.queries");
const { localDate } = require("../../utils/date");
const {
  getActiveJornadaDate,
} = require("../businessDays/businessDays.service");

const getDashboard = async (date) => {
  const target = date || (await getActiveJornadaDate());
  const [data, closed] = await Promise.all([
    queries.getDashboard(target),
    queries.findByDate(target),
  ]);
  return {
    date: target,
    is_closed: !!closed,
    cash_amount: data.cash_amount,
    transfer_amount: data.transfer_amount,
    total_collected: data.total_collected,
    total_outflows: data.total_outflows,
    net_balance: data.net_balance,
    approved_count: data.approved_count,
    pending_count: data.pending_count,
    pending_amount: data.pending_amount,
    down_payments_total: data.down_payments_total,
    down_payments_count: data.down_payments_count,
  };
};

const close = async (data, adminId) => {
  const today = localDate();
  const registerDate = data.register_date || (await getActiveJornadaDate());

  if (registerDate > today)
    throw {
      status: 422,
      message: "No se puede cerrar una caja de fecha futura.",
    };

  const existing = await queries.findByDate(registerDate);
  if (existing)
    throw {
      status: 409,
      message: `Ya existe un cierre de caja para el ${registerDate}.`,
    };

  // El chequeo de pre-cargas pendientes aplica siempre que la jornada tenga cobros
  // sin aprobar, incluyendo el caso post-medianoche (registerDate = ayer).
  if (!data.force) {
    const pending = await queries.getPendingPaymentsToday(registerDate);
    if (pending.count > 0)
      throw {
        status: 409,
        message: `Hay ${pending.count} pre-carga(s) pendiente(s) de aprobación por $${pending.amount}. Aprobá o rechazá antes de cerrar, o enviá force: true para cerrar igual.`,
        pending_payments: pending,
      };
  }

  const totals = await queries.getDailyTotals(registerDate);
  const cashAmount = totals.cash_amount; // neto: ingresos_efec - egresos_efec
  const transferAmount = totals.transfer_amount; // neto: ingresos_transf - egresos_transf
  const totalCollected = totals.gross_cash + totals.gross_transfer; // ingresos brutos (dato contable)
  const totalOutflows = totals.total_outflows;
  const declaredCash = parseFloat(data.declared_cash);
  const difference = declaredCash - cashAmount; // arqueo real sobre efectivo neto

  let differenceStatus = "EXACT";
  if (difference > 0) differenceStatus = "SURPLUS";
  if (difference < 0) differenceStatus = "SHORTAGE";

  // Transacción: crear cierre y vincular liquidaciones de la fecha
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const register = await queries.create(client, {
      registerDate,
      cashAmount,
      transferAmount,
      totalCollected,
      totalOutflows,
      declaredCash,
      difference,
      differenceStatus,
      observations: data.observations,
      closedBy: adminId,
    });

    // CRIT-2 (Fase 3): NO se llama linkLiquidations. Las liquidaciones de
    // comisiones ahora son tesorería (Caja General) y no deben quedar
    // enlazadas al cierre legacy de cash_registers — eso producía un cierre
    // "apropiado" de movimientos que ya estaban imputados a cash_account_movements.

    await client.query("COMMIT");
    return register;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

const getPreClose = async (date) => {
  const target = date || (await getActiveJornadaDate());
  const data = await queries.getPreClose(target);
  return {
    date: target,
    ingresos: {
      cobros_efectivo: data.cobros_efectivo,
      cobros_transferencia: data.cobros_transferencia,
      enganches_efectivo: data.enganches_efectivo,
      enganches_transferencia: data.enganches_transferencia,
      total_bruto: data.total_bruto,
    },
    egresos: {
      gastos_efectivo: data.gastos_efectivo,
      gastos_transferencia: data.gastos_transferencia,
      comisiones_efectivo: data.comisiones_efectivo,
      comisiones_transferencia: data.comisiones_transferencia,
      total: data.total_egresos,
    },
    efectivo: {
      esperado: data.efectivo_esperado,
    },
    transferencias: {
      esperado: data.transferencia_esperada,
    },
    pendientes: {
      count: data.pendientes_count,
      amount: data.pendientes_amount,
    },
  };
};

const getAll = async (filters) => queries.findAll(filters);

const getById = async (id) => {
  const register = await queries.findById(id);
  if (!register)
    throw { status: 404, message: "Cierre de caja no encontrado." };
  return register;
};

/**
 * Obtiene los movimientos normalizados de una caja operativa.
 * @param {string} cashSessionId - ID de cash_sessions.
 * @returns {Promise<object[]>} Movimientos unificados de la sesión.
 */
const getSessionMovements = async (cashSessionId) =>
  queries.findMovementsBySessionId(cashSessionId);

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
    throw {
      status: 409,
      message: `La caja del ${registerDate} ya está cerrada. No se pueden registrar conversiones.`,
    };

  const cashSessionsQueries = require("../cashSessions/cashSessions.queries");

  const amount = parseFloat(data.amount);
  if (!Number.isFinite(amount) || amount <= 0)
    throw {
      status: 422,
      message: "El monto de conversión debe ser mayor a 0.",
    };

  const sourceMethod = data.source_method;
  const targetMethod = sourceMethod === "CASH" ? "TRANSFER" : "CASH";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // V4.3: la conversión se imputa a la caja activa de la jornada (no del admin).
    const activeSession =
      await cashSessionsQueries.lockActiveSessionForCurrentJornada(client);
    if (!activeSession) {
      await client.query("ROLLBACK");
      throw {
        status: 409,
        message:
          "No hay caja operativa abierta. Abrí una caja para registrar conversiones.",
        code: "NO_ACTIVE_SESSION",
      };
    }
    const conversion = await queries.createConversion(client, {
      registerDate,
      criteria: data.criteria,
      sourceMethod,
      targetMethod,
      amount,
      notes: data.notes,
      cashSessionId: activeSession.id,
      createdBy: adminId,
    });
    await client.query("COMMIT");
    return conversion;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

module.exports = {
  getDashboard,
  getPreClose,
  close,
  getAll,
  getById,
  getActiveJornadaDate,
  createConversion,
  getSessionMovements,
};
