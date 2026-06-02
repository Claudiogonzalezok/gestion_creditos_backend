const queries        = require('./cashSessions.queries');
const bdQueries      = require('../businessDays/businessDays.queries');
const { withTransaction } = require('../../utils/transaction');
const { localDate }       = require('../../utils/date');

const SNAPSHOT_VERSION = 1;

/**
 * Construye el snapshot inmutable del cierre de una caja. Fuente de verdad de
 * la auditoría: el JSON guardado en closure_snapshot. La versión permite
 * evolucionar el formato sin romper snapshots viejos.
 */
const buildClosureSnapshot = ({
  session, totals, drops, declared, capturedBy,
}) => {
  const opening = { cash: session.opening_amount, transfer: 0 };
  const collections = {
    payments:      { cash: totals.collections_payments_cash,        transfer: totals.collections_payments_transfer },
    down_payments: { cash: totals.collections_down_payments_cash,   transfer: totals.collections_down_payments_transfer },
  };
  const outflows = {
    expenses:    { cash: totals.outflows_expenses_cash,    transfer: totals.outflows_expenses_transfer },
    commissions: { cash: totals.outflows_commissions_cash, transfer: totals.outflows_commissions_transfer },
  };
  const conversions = {
    cash_delta:     totals.conversions_cash_delta,
    transfer_delta: totals.conversions_transfer_delta,
  };
  const dropsBlock = {
    cash:     totals.drops_cash,
    transfer: totals.drops_transfer,
    items: drops
      .filter((d) => d.status === 'ACTIVE')
      .map((d) => ({ id: d.id, amount: d.amount, payment_method: d.payment_method, destination: d.destination })),
  };

  const expectedCash =
    opening.cash
    + collections.payments.cash + collections.down_payments.cash
    - outflows.expenses.cash    - outflows.commissions.cash
    + conversions.cash_delta
    - dropsBlock.cash;
  const expectedTransfer =
    opening.transfer
    + collections.payments.transfer + collections.down_payments.transfer
    - outflows.expenses.transfer    - outflows.commissions.transfer
    + conversions.transfer_delta
    - dropsBlock.transfer;

  return {
    version:     SNAPSHOT_VERSION,
    captured_at: new Date().toISOString(),
    captured_by: capturedBy,
    opening,
    collections,
    outflows,
    conversions,
    drops: dropsBlock,
    expected: { cash: expectedCash, transfer: expectedTransfer },
    declared: { cash: declared.cash, transfer: declared.transfer },
    difference: {
      cash:     declared.cash     - expectedCash,
      transfer: declared.transfer - expectedTransfer,
    },
  };
};

const differenceStatusOf = (n) => {
  if (n > 0) return 'SURPLUS';
  if (n < 0) return 'SHORTAGE';
  return 'EXACT';
};

/**
 * Resuelve la jornada activa (la del día actual + sucursal default); si no
 * existe la crea. Garantiza idempotencia frente a carreras vía la unique
 * constraint (business_date, branch_id).
 */
const resolveOrCreateBusinessDay = async (client, branchId) => {
  const businessDate = localDate();
  const existing = await bdQueries.findByDateAndBranch(businessDate, branchId, client);
  if (existing) return existing;
  try {
    return await bdQueries.create(client, { businessDate, branchId });
  } catch (err) {
    // Race con otra request que creó la jornada en simultáneo → la leo.
    if (err.code === '23505') {
      const again = await bdQueries.findByDateAndBranch(businessDate, branchId, client);
      if (again) return again;
    }
    throw err;
  }
};

// ── Apertura ───────────────────────────────────────────────────────────────

/**
 * Abre una caja para el owner (default: el usuario que ejecuta la acción).
 * Falla si ese owner ya tiene una caja OPEN (la unique index parcial blinda
 * además a nivel DB).
 *
 * @param {object} data
 * @param {number} data.opening_amount
 * @param {string} [data.owner_user_id]
 * @param {string} [data.branch_id]
 * @param {string} [data.observations]
 * @param {object} requestingUser
 */
const open = async (data, requestingUser) => {
  const ownerUserId = data.owner_user_id || requestingUser.id;
  const openingAmount = parseFloat(data.opening_amount);
  if (!Number.isFinite(openingAmount) || openingAmount < 0)
    throw { status: 422, message: 'opening_amount debe ser un número >= 0.' };

  return withTransaction(async (client) => {
    // Resuelve sucursal (default HQ).
    let branchId = data.branch_id;
    if (branchId) {
      const branch = await bdQueries.findActiveBranchById(branchId, client);
      if (!branch) throw { status: 404, message: 'Sucursal no encontrada o inactiva.' };
    } else {
      const def = await bdQueries.findDefaultBranch(client);
      if (!def) throw { status: 500, message: 'No hay sucursales configuradas.' };
      branchId = def.id;
    }

    // Bloqueo de "una OPEN por owner" — pre-chequeo amistoso + la unique index
    // como cinturón de seguridad.
    const open = await queries.findOpenByOwner(ownerUserId, client);
    if (open) {
      throw {
        status: 409,
        message: `El operador ya tiene una caja abierta (id ${open.id}). Cerrala o pasala a PENDING antes de abrir otra.`,
        existing_session_id: open.id,
      };
    }

    const businessDay = await resolveOrCreateBusinessDay(client, branchId);
    if (['CLOSED', 'AUDITED'].includes(businessDay.status))
      throw { status: 409, message: `La jornada del ${businessDay.business_date} ya está ${businessDay.status}. No se pueden abrir nuevas cajas.` };

    try {
      const session = await queries.create(client, {
        businessDayId: businessDay.id,
        ownerUserId,
        openedBy:      requestingUser.id,
        openingAmount,
        observations:  data.observations,
      });
      return { ...session, business_day: businessDay };
    } catch (err) {
      if (err.code === '23505') {
        throw { status: 409, message: 'Otra sesión OPEN del mismo owner fue creada en simultáneo. Reintentá.' };
      }
      throw err;
    }
  });
};

// ── Snapshot vivo (X report) ───────────────────────────────────────────────

const snapshot = async (id) => {
  const session = await queries.findByIdWithDetails(id);
  if (!session) throw { status: 404, message: 'Caja no encontrada.' };

  const totals = await queries.computeSessionTotals(id);
  const opening = { cash: session.opening_amount, transfer: 0 };
  const dropsBlock = {
    cash:     totals.drops_cash,
    transfer: totals.drops_transfer,
    items: session.drops
      .filter((d) => d.status === 'ACTIVE')
      .map((d) => ({ id: d.id, amount: d.amount, payment_method: d.payment_method, destination: d.destination })),
  };
  const expectedCash =
    opening.cash
    + totals.collections_payments_cash + totals.collections_down_payments_cash
    - totals.outflows_expenses_cash    - totals.outflows_commissions_cash
    + totals.conversions_cash_delta
    - dropsBlock.cash;
  const expectedTransfer =
    opening.transfer
    + totals.collections_payments_transfer + totals.collections_down_payments_transfer
    - totals.outflows_expenses_transfer    - totals.outflows_commissions_transfer
    + totals.conversions_transfer_delta
    - dropsBlock.transfer;

  return {
    session_id: session.id,
    status:     session.status,
    owner_user_id: session.owner_user_id,
    opened_at:  session.opened_at,
    opening,
    collections: {
      payments:      { cash: totals.collections_payments_cash,        transfer: totals.collections_payments_transfer },
      down_payments: { cash: totals.collections_down_payments_cash,   transfer: totals.collections_down_payments_transfer },
    },
    outflows: {
      expenses:    { cash: totals.outflows_expenses_cash,    transfer: totals.outflows_expenses_transfer },
      commissions: { cash: totals.outflows_commissions_cash, transfer: totals.outflows_commissions_transfer },
    },
    conversions: {
      cash_delta:     totals.conversions_cash_delta,
      transfer_delta: totals.conversions_transfer_delta,
    },
    drops: dropsBlock,
    expected: { cash: expectedCash, transfer: expectedTransfer },
  };
};

// ── Cierre ──────────────────────────────────────────────────────────────────

/**
 * Cierra una caja OPEN. Requiere `declared` por método de pago (al menos cash
 * y transfer; otros métodos como MP/QR/CHECK quedan en cero si no se reportan).
 *
 * @param {string} id
 * @param {object} data
 * @param {Array<{payment_method, declared_amount, notes?}>} data.declared
 * @param {object} requestingUser
 */
const close = async (id, data, requestingUser) => {
  if (!Array.isArray(data.declared) || data.declared.length === 0)
    throw { status: 422, message: 'declared debe ser un array con al menos un método de pago.' };

  await withTransaction(async (client) => {
    const session = await queries.lockAndGetById(client, id);
    if (!session) throw { status: 404, message: 'Caja no encontrada.' };
    if (session.status !== 'OPEN')
      throw { status: 409, message: `La caja no está OPEN (estado actual: ${session.status}).` };

    const totals = await queries.computeSessionTotals(id, client);
    const drops  = await queries.findDropsBySession(id);

    // Mapeo de declared por método (default 0).
    const declaredByMethod = new Map(
      data.declared.map((d) => [d.payment_method, parseFloat(d.declared_amount)]),
    );
    const cashDeclared     = declaredByMethod.get('CASH')     || 0;
    const transferDeclared = declaredByMethod.get('TRANSFER') || 0;

    const snapshot = buildClosureSnapshot({
      session: { ...session },
      totals,
      drops,
      declared:   { cash: cashDeclared, transfer: transferDeclared },
      capturedBy: requestingUser.id,
    });

    const totalDifference = snapshot.difference.cash + snapshot.difference.transfer;
    const totalDiffStatus = differenceStatusOf(totalDifference);

    // Persistir cierre + detalles por método.
    const details = data.declared.map((d) => {
      const expected = (d.payment_method === 'CASH')
        ? snapshot.expected.cash
        : (d.payment_method === 'TRANSFER') ? snapshot.expected.transfer : 0;
      const declared = parseFloat(d.declared_amount);
      const diff     = declared - expected;
      return {
        payment_method:    d.payment_method,
        expected_amount:   expected,
        declared_amount:   declared,
        difference:        diff,
        difference_status: differenceStatusOf(diff),
      };
    });

    const closed = await queries.close(client, id, {
      closedBy:        requestingUser.id,
      snapshot,
      totalDifference,
      diffStatus:      totalDiffStatus,
    });
    if (!closed) throw { status: 409, message: 'La caja cambió de estado durante el cierre. Reintentá.' };

    await queries.insertClosureDetails(client, id, details);

    // Si todas las cajas de la jornada terminales → READY_TO_CLOSE automático.
    await bdQueries.maybeTransitionToReadyToClose(client, session.business_day_id);
  });
  return queries.findByIdWithDetails(id);
};

// ── PENDING_RECONCILIATION ─────────────────────────────────────────────────

const markPending = async (id, data, requestingUser) => {
  const reason = (data.reason || '').trim();
  if (!reason) throw { status: 422, message: 'Tenés que indicar el motivo para marcar la caja PENDING.' };

  await withTransaction(async (client) => {
    const session = await queries.lockAndGetById(client, id);
    if (!session) throw { status: 404, message: 'Caja no encontrada.' };
    if (session.status !== 'OPEN')
      throw { status: 409, message: `Solo se pueden marcar PENDING cajas OPEN (estado actual: ${session.status}).` };

    const updated = await queries.markPending(client, id, { reason });
    if (!updated) throw { status: 409, message: 'La caja cambió de estado. Reintentá.' };
  });
  return queries.findByIdWithDetails(id);
};

const reconcile = async (id, data, requestingUser) => {
  if (!Array.isArray(data.declared) || data.declared.length === 0)
    throw { status: 422, message: 'declared debe ser un array con al menos un método de pago.' };

  await withTransaction(async (client) => {
    const session = await queries.lockAndGetById(client, id);
    if (!session) throw { status: 404, message: 'Caja no encontrada.' };
    if (session.status !== 'PENDING_RECONCILIATION')
      throw { status: 409, message: `Solo se reconcilian cajas PENDING_RECONCILIATION (estado actual: ${session.status}).` };

    const totals = await queries.computeSessionTotals(id, client);
    const drops  = await queries.findDropsBySession(id);

    const declaredByMethod = new Map(
      data.declared.map((d) => [d.payment_method, parseFloat(d.declared_amount)]),
    );
    const cashDeclared     = declaredByMethod.get('CASH')     || 0;
    const transferDeclared = declaredByMethod.get('TRANSFER') || 0;

    const snapshot = buildClosureSnapshot({
      session: { ...session },
      totals,
      drops,
      declared:   { cash: cashDeclared, transfer: transferDeclared },
      capturedBy: requestingUser.id,
    });
    snapshot.late_reconciliation = true;

    const totalDifference = snapshot.difference.cash + snapshot.difference.transfer;
    const totalDiffStatus = differenceStatusOf(totalDifference);

    const details = data.declared.map((d) => {
      const expected = (d.payment_method === 'CASH')
        ? snapshot.expected.cash
        : (d.payment_method === 'TRANSFER') ? snapshot.expected.transfer : 0;
      const declared = parseFloat(d.declared_amount);
      const diff     = declared - expected;
      return {
        payment_method:    d.payment_method,
        expected_amount:   expected,
        declared_amount:   declared,
        difference:        diff,
        difference_status: differenceStatusOf(diff),
      };
    });

    const ok = await queries.reconcile(client, id, {
      reconciledBy: requestingUser.id,
      snapshot,
      totalDifference,
      diffStatus:   totalDiffStatus,
    });
    if (!ok) throw { status: 409, message: 'La caja cambió de estado. Reintentá.' };
    await queries.insertClosureDetails(client, id, details);

    await bdQueries.maybeTransitionToReadyToClose(client, session.business_day_id);
  });
  return queries.findByIdWithDetails(id);
};

// ── Drops ──────────────────────────────────────────────────────────────────

const addDrop = async (id, data, requestingUser) => {
  const amount = parseFloat(data.amount);
  if (!Number.isFinite(amount) || amount <= 0)
    throw { status: 422, message: 'amount debe ser un número > 0.' };
  if (!['CASH', 'TRANSFER'].includes(data.payment_method))
    throw { status: 422, message: 'payment_method debe ser CASH o TRANSFER.' };
  const destination = (data.destination || '').trim();
  if (!destination) throw { status: 422, message: 'destination es obligatorio.' };

  return withTransaction(async (client) => {
    const session = await queries.lockAndGetById(client, id);
    if (!session) throw { status: 404, message: 'Caja no encontrada.' };
    if (session.status !== 'OPEN')
      throw { status: 409, message: `Solo se agregan drops a cajas OPEN (estado actual: ${session.status}).` };

    return queries.createDrop(client, id, {
      amount,
      paymentMethod:    data.payment_method,
      destination,
      reason:           data.reason,
      receiptReference: data.receipt_reference,
      performedBy:      requestingUser.id,
    });
  });
};

const reverseDrop = async (sessionId, dropId, data, requestingUser) => {
  const reason = (data.reason || '').trim();
  if (!reason) throw { status: 422, message: 'reason es obligatorio para revertir un drop.' };

  return withTransaction(async (client) => {
    const session = await queries.lockAndGetById(client, sessionId);
    if (!session) throw { status: 404, message: 'Caja no encontrada.' };
    if (session.status !== 'OPEN')
      throw { status: 409, message: 'Solo se revierten drops de cajas OPEN.' };

    const drop = await queries.findDropById(dropId, client);
    if (!drop || drop.cash_session_id !== sessionId)
      throw { status: 404, message: 'Drop no encontrado en esta caja.' };
    if (drop.status !== 'ACTIVE')
      throw { status: 409, message: `Solo se revierten drops ACTIVE (estado actual: ${drop.status}).` };

    const reversed = await queries.reverseDrop(client, dropId, {
      reversedBy: requestingUser.id,
      reason,
    });
    if (!reversed) throw { status: 409, message: 'El drop cambió de estado. Reintentá.' };
    return queries.findDropById(dropId, client);
  });
};

// ── Listados / detalle ────────────────────────────────────────────────────

const getActive = async (ownerUserId) => queries.findOpenByOwner(ownerUserId);
const getById   = async (id) => {
  const s = await queries.findByIdWithDetails(id);
  if (!s) throw { status: 404, message: 'Caja no encontrada.' };
  return s;
};
const getAll = async (filters) => queries.findAll(filters);

module.exports = {
  open, close, snapshot, markPending, reconcile,
  addDrop, reverseDrop,
  getActive, getById, getAll,
};
