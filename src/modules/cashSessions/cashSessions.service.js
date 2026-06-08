const queries        = require('./cashSessions.queries');
const bdQueries      = require('../businessDays/businessDays.queries');
const cashAccountsQueries = require('../cashAccounts/cashAccounts.queries');
const cashAccountsService = require('../cashAccounts/cashAccounts.service');
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
 * V4.4: abre una caja operativa para la jornada.
 *
 * Reglas (V4 — directiva arquitectónica oficial):
 *   1. owner_user_id deja de representar al "dueño del dinero" — pasa a ser
 *      el cajero responsable del turno. El nombre del campo se conserva por
 *      compat de schema; la semántica cambia.
 *   2. Solo puede existir UNA caja OPEN simultáneamente por business_day
 *      (independientemente del owner). Si ya hay otra OPEN en la jornada,
 *      esta apertura falla con 409 ACTIVE_SESSION_IN_BUSINESS_DAY.
 *   3. Si la jornada está en READY_TO_CLOSE (porque la caja anterior cerró
 *      y todas estaban CLOSED), abrir una nueva caja la revierte a OPEN.
 *      Esto permite jornadas multi-turno (8-12, 16-22, 23-04 etc.) sin
 *      cerrar formalmente la jornada entre cajas.
 *
 * El invariante "una OPEN por jornada" será endurecido a nivel DB con la
 * migración 027 (V4.5). Hasta entonces el chequeo a nivel service es la
 * única protección.
 *
 * @param {object} data
 * @param {number} data.opening_amount
 * @param {string} [data.owner_user_id]   (cajero del turno)
 * @param {string} [data.branch_id]
 * @param {string} [data.observations]
 * @param {string} [data.shift_label]
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

    // Resolver o crear la jornada del día.
    const businessDay = await resolveOrCreateBusinessDay(client, branchId);
    if (['CLOSED', 'AUDITED'].includes(businessDay.status))
      throw {
        status: 409,
        message: `La jornada del ${businessDay.business_date} ya está ${businessDay.status}. No se pueden abrir nuevas cajas.`,
      };

    // V4.4: unicidad por jornada (no por owner). Solo una OPEN simultánea
    // por business_day. Si la jornada está en READY_TO_CLOSE, la revertimos
    // a OPEN porque va a tener una caja activa nueva.
    const existingActive = await queries.findActiveSessionByBusinessDay(
      businessDay.id, client,
    );
    if (existingActive) {
      throw {
        status: 409,
        message: `Ya hay una caja operativa abierta en la jornada (id ${existingActive.id}). Cerrala antes de abrir otra.`,
        code: 'ACTIVE_SESSION_IN_BUSINESS_DAY',
        existing_session_id: existingActive.id,
      };
    }

    if (businessDay.status === 'READY_TO_CLOSE') {
      const reverted = await bdQueries.revertToOpen(client, businessDay.id);
      if (reverted) businessDay.status = 'OPEN';
    }

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
        // V4.5 (migración 027) reemplaza one_open_session_per_owner_idx por
        // one_open_session_per_business_day_idx → este error pasa a indicar
        // que otra request abrió la caja primero.
        throw {
          status: 409,
          message: 'Otra caja operativa fue abierta en la jornada en simultáneo. Reintentá.',
          code: 'ACTIVE_SESSION_IN_BUSINESS_DAY',
        };
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

/**
 * Resuelve la cuenta destino del drop. Si el caller no especifica
 * destination_account_id, defaultea a la Caja General. Valida que la cuenta
 * exista y esté activa.
 */
const resolveDropDestinationAccount = async (client, destinationAccountId) => {
  if (destinationAccountId) {
    const acc = await cashAccountsQueries.findById(destinationAccountId, client);
    if (!acc || !acc.is_active)
      throw { status: 404, message: 'Cuenta destino no encontrada o inactiva.' };
    return acc;
  }
  const def = await cashAccountsQueries.findGeneralCashAccount(client);
  if (!def) throw { status: 500, message: 'No hay Caja General configurada.' };
  return def;
};

const addDrop = async (id, data, requestingUser) => {
  const amount = parseFloat(data.amount);
  if (!Number.isFinite(amount) || amount <= 0)
    throw { status: 422, message: 'amount debe ser un número > 0.' };
  if (!['CASH', 'TRANSFER'].includes(data.payment_method))
    throw { status: 422, message: 'payment_method debe ser CASH o TRANSFER.' };
  // destination (texto libre) es opcional desde Fase 3: si no viene, se deja
  // null. La cuenta destino real va por destination_account_id.
  const destination = (data.destination || '').trim() || null;

  return withTransaction(async (client) => {
    const session = await queries.lockAndGetById(client, id);
    if (!session) throw { status: 404, message: 'Caja no encontrada.' };
    if (session.status !== 'OPEN')
      throw { status: 409, message: `Solo se agregan drops a cajas OPEN (estado actual: ${session.status}).` };

    const destinationAccount = await resolveDropDestinationAccount(
      client, data.destination_account_id,
    );

    const drop = await queries.createDrop(client, id, {
      amount,
      paymentMethod:        data.payment_method,
      destination,
      destinationAccountId: destinationAccount.id,
      reason:               data.reason,
      receiptReference:     data.receipt_reference,
      performedBy:          requestingUser.id,
    });

    // Generar el DROP_IN automático en la cuenta destino, misma transacción.
    // beneficiary_name = owner de la sesión (para trazabilidad por beneficiario).
    const owner = await client.query(
      `SELECT full_name FROM users WHERE id = $1`, [session.owner_user_id],
    );
    const ownerName = owner.rows[0]?.full_name || null;

    await cashAccountsService.insertMovementWithBalance(client, {
      cashAccountId: destinationAccount.id,
      movementType:  'DROP_IN',
      direction:     'IN',
      amount,
      description:   `Drop ${data.payment_method} de caja ${id}`,
      beneficiaryName: ownerName,
      referenceType: 'CASH_SESSION_DROP',
      referenceId:   drop.id,
      createdBy:     requestingUser.id,
    });

    return drop;
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

    // 1) Marcar el drop como REVERSED.
    const reversed = await queries.reverseDrop(client, dropId, {
      reversedBy: requestingUser.id,
      reason,
    });
    if (!reversed) throw { status: 409, message: 'El drop cambió de estado. Reintentá.' };

    // 2) Compensar en la cuenta destino con un ADJUSTMENT OUT por el mismo monto.
    //    Apunta polimórficamente al DROP_IN original. Puede fallar 409
    //    INSUFFICIENT_BALANCE — en ese caso toda la tx (incluido el step 1)
    //    revierte y el drop queda intacto.
    const originalDropIn = await cashAccountsQueries.findMovementByReference({
      referenceType: 'CASH_SESSION_DROP',
      referenceId:   dropId,
      movementType:  'DROP_IN',
    }, client);
    if (!originalDropIn) {
      // Caso de drop legacy backfilleado sin DROP_IN: no se puede compensar.
      // Lanzamos 500 con mensaje claro — debería investigarse manualmente.
      throw { status: 500, message: 'No se encontró el DROP_IN asociado al drop. Investigar manualmente.' };
    }

    await cashAccountsService.insertMovementWithBalance(client, {
      cashAccountId: originalDropIn.cash_account_id,
      movementType:  'ADJUSTMENT',
      direction:     'OUT',
      amount:        drop.amount,
      description:   `Reverso de drop ${dropId} — ${reason}`,
      beneficiaryName: originalDropIn.beneficiary_name,
      referenceType: 'CASH_ACCOUNT_MOVEMENT',
      referenceId:   originalDropIn.id,
      createdBy:     requestingUser.id,
    });

    return queries.findDropById(dropId, client);
  });
};

// ── Listados / detalle ────────────────────────────────────────────────────

/**
 * V4: devuelve la caja operativa activa de la jornada actual (sucursal default).
 *
 * Reemplaza el concepto viejo "mi caja" (que en V4 ya no existe — los cobradores
 * no tienen caja, y la caja es de la jornada no del usuario). El parámetro
 * `_ownerUserId` se acepta por compat con callers viejos del controller pero
 * se ignora: la caja activa es única por jornada.
 *
 * Devuelve null si no hay caja activa (jornada cerrada o sin abrir todavía).
 */
const getActive = async (/* _ownerUserId */) => {
  const branch = await bdQueries.findDefaultBranch();
  if (!branch) return null;
  const businessDay = await bdQueries.findActiveBusinessDay(branch.id);
  if (!businessDay) return null;
  return queries.findActiveSessionByBusinessDay(businessDay.id);
};

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
