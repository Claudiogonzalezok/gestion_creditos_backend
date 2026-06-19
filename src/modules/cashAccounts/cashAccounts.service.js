const queries = require("./cashAccounts.queries");
const { withTransaction } = require("../../utils/transaction");

// Dirección fija para tipos no-ADJUSTMENT. ADJUSTMENT requiere direction
// explícito desde el caller.
const FIXED_DIRECTION = {
  DROP_IN: "IN",
  SUPPLIER_PAYMENT: "OUT",
  SALARY_PAYMENT: "OUT",
  EXPENSE: "OUT",
  MANUAL_INCOME: "IN",
};

// IMP-6: SALARY_PAYMENT NO se acepta desde el endpoint público — debe pasar
// por commissions.liquidate, que es la única fuente con trazabilidad de
// período liquidado y mata el riesgo de doble pago (manual + liquidación).
const PUBLIC_MOVEMENT_TYPES = [
  "SUPPLIER_PAYMENT",
  "EXPENSE",
  "ADJUSTMENT",
  "MANUAL_INCOME",
];

const round2 = (n) => Math.round(n * 100) / 100;
const hasValue = (v) =>
  v !== undefined && v !== null && String(v).trim() !== "";

const err = (status, message, code) => {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
};

const resolveDirection = (movementType, requestedDirection) => {
  if (movementType === "ADJUSTMENT") {
    if (!["IN", "OUT"].includes(requestedDirection)) {
      throw err(
        422,
        "ADJUSTMENT requiere direction IN u OUT.",
        "INVALID_DIRECTION",
      );
    }
    return requestedDirection;
  }
  // Para el resto, la direction es fija — se ignora cualquier valor del cliente.
  return FIXED_DIRECTION[movementType];
};

/**
 * Lógica transaccional core: lock fila de la cuenta, valida saldo nunca
 * negativo (regla universal), inserta movimiento y actualiza current_balance.
 * Devuelve el movimiento insertado y el nuevo balance.
 *
 * Es la ÚNICA puerta por donde se modifica current_balance: cualquier inserción
 * de movimiento (manual o automática) debe pasar por acá.
 */
const insertMovementWithBalance = async (client, params) => {
  const {
    cashAccountId,
    movementType,
    direction,
    amount,
    amountCash,
    amountTransfer,
    description,
    beneficiaryName,
    referenceType,
    referenceId,
    createdBy,
  } = params;

  // 1) Lock fila de la cuenta + leer balance fresco.
  const account = await queries.lockAndGetBalance(client, cashAccountId);
  if (!account) throw err(404, "Cuenta no encontrada.", "NOT_FOUND");
  if (!account.is_active)
    throw err(
      409,
      "La cuenta está inactiva. No se pueden registrar movimientos.",
      "ACCOUNT_INACTIVE",
    );

  // 2) Calcular nuevo saldo según direction.
  const delta = direction === "IN" ? amount : -amount;
  const newBalance = Number((account.current_balance + delta).toFixed(2));

  // 3) Validar regla universal: saldo nunca negativo.
  if (newBalance < 0) {
    throw err(
      409,
      `Saldo insuficiente en la cuenta. Saldo actual: ${account.current_balance}. Monto requerido: ${amount}.`,
      "INSUFFICIENT_BALANCE",
    );
  }

  // 4) Insertar movimiento.
  const movement = await queries.insertMovement(client, {
    cashAccountId,
    movementType,
    direction,
    amount,
    amountCash: direction === "IN" ? (amountCash ?? amount) : 0,
    amountTransfer: direction === "IN" ? (amountTransfer ?? 0) : 0,
    description,
    beneficiaryName,
    referenceType,
    referenceId,
    createdBy,
  });

  // 5) Actualizar cache.
  await queries.updateCurrentBalance(client, cashAccountId, newBalance);

  return { movement, newBalance };
};

// ── Endpoints públicos ─────────────────────────────────────────────────────

const getAll = async () => queries.findAllActive();

const getById = async (id) => {
  const account = await queries.findById(id);
  if (!account) throw err(404, "Cuenta no encontrada.", "NOT_FOUND");
  return account;
};

const getBalance = async (id) => {
  const account = await getById(id);
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    current_balance: account.current_balance,
  };
};

/**
 * Audita el cache vs la fuente de verdad. Si drift !== 0 hay desincronización
 * y conviene investigar (¿hubo escritura directa a current_balance? ¿bug en un
 * flujo de inserción?). El endpoint expone esto sin auto-corregir: la
 * reparación se hace explícitamente con recomputeBalance().
 */
const getAuditBalance = async (id) => {
  const account = await getById(id);
  const computed = await queries.computeBalanceFromMovements(id);
  const drift = Number((account.current_balance - computed).toFixed(2));
  return {
    id: account.id,
    name: account.name,
    cached: account.current_balance,
    computed,
    drift,
  };
};

const listMovements = async (
  id,
  { movementType, direction, from, to, page = 1, pageSize = 20 },
) => {
  await getById(id); // 404 si no existe
  const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (safePage - 1) * safePageSize;

  const filters = { accountId: id, movementType, direction, from, to };
  const [items, total] = await Promise.all([
    queries.findMovements({ ...filters, limit: safePageSize, offset }),
    queries.countMovements(filters),
  ]);
  return {
    items,
    pagination: {
      page: safePage,
      page_size: safePageSize,
      total,
      total_pages: Math.ceil(total / safePageSize),
    },
  };
};

/**
 * Registra un movimiento desde el endpoint público (egresos corporativos +
 * ajustes contables). NO requiere caja OPEN del admin — es operación de
 * tesorería, no de caja operativa.
 */
const registerMovement = async (accountId, body, user) => {
  const {
    movementType,
    direction: requestedDirection,
    description,
    beneficiaryName,
  } = body;

  if (!PUBLIC_MOVEMENT_TYPES.includes(movementType)) {
    throw err(
      422,
      `movement_type inválido. Permitidos: ${PUBLIC_MOVEMENT_TYPES.join(", ")}.`,
      "INVALID_MOVEMENT_TYPE",
    );
  }
  const direction = resolveDirection(movementType, requestedDirection);
  const hasSplit = hasValue(body.amount_cash) || hasValue(body.amount_transfer);
  const amountCash = hasSplit
    ? round2(parseFloat(body.amount_cash) || 0)
    : null;
  const amountTransfer = hasSplit
    ? round2(parseFloat(body.amount_transfer) || 0)
    : null;
  const amount = hasSplit
    ? round2(amountCash + amountTransfer)
    : round2(parseFloat(body.amount));

  if (!(amount > 0)) {
    throw err(422, "amount debe ser > 0.", "INVALID_AMOUNT");
  }
  if (hasSplit && direction !== "IN") {
    throw err(
      422,
      "El desglose por medio solo aplica a movimientos IN.",
      "INVALID_SPLIT_DIRECTION",
    );
  }
  if (hasSplit && (amountCash < 0 || amountTransfer < 0)) {
    throw err(
      422,
      "amount_cash y amount_transfer no pueden ser negativos.",
      "INVALID_SPLIT_AMOUNT",
    );
  }
  if (
    hasSplit &&
    hasValue(body.amount) &&
    round2(parseFloat(body.amount)) !== amount
  ) {
    throw err(
      422,
      "amount debe coincidir con amount_cash + amount_transfer.",
      "INVALID_SPLIT_TOTAL",
    );
  }

  const { movement, newBalance } = await withTransaction(async (client) => {
    return insertMovementWithBalance(client, {
      cashAccountId: accountId,
      movementType,
      direction,
      amount,
      amountCash: hasSplit ? amountCash : undefined,
      amountTransfer: hasSplit ? amountTransfer : undefined,
      description,
      beneficiaryName,
      referenceType: null,
      referenceId: null,
      createdBy: user.id,
    });
  });

  return { movement, current_balance: newBalance };
};

module.exports = {
  // públicos
  getAll,
  getById,
  getBalance,
  getAuditBalance,
  listMovements,
  registerMovement,
  // helpers internos (reutilizables por cashSessions/commissions en commits siguientes)
  insertMovementWithBalance,
  resolveDirection,
  FIXED_DIRECTION,
  PUBLIC_MOVEMENT_TYPES,
};
