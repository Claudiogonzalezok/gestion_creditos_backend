const queries = require("./cashAccounts.queries");
const { withTransaction } = require("../../utils/transaction");
const { round2 } = require("../../utils/money");

// Dirección fija para tipos no-ADJUSTMENT. ADJUSTMENT requiere direction
// explícito desde el caller.
const FIXED_DIRECTION = {
  DROP_IN: "IN",
  SUPPLIER_PAYMENT: "OUT",
  SALARY_PAYMENT: "OUT",
  EXPENSE: "OUT",
  MANUAL_INCOME: "IN",
};

// IMP-6: SALARY_PAYMENT no es público (ver cashAccounts.constants).
const { PUBLIC_MOVEMENT_TYPES } = require("./cashAccounts.constants");

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
 * Saldos por medio de una cuenta ya leída (idealmente bajo lock FOR UPDATE).
 * cash_balance = current_balance - transfer_balance, así la suma siempre
 * coincide con current_balance.
 * @param {object} db - Pool o client de la transacción.
 * @param {{id:string, current_balance:number}} account - Cuenta.
 * @returns {Promise<{cash_balance:number, transfer_balance:number}>}
 */
const getMethodBalances = async (db, account) => {
  // Todo egreso declara su medio, así que no hay reparto implícito entre medios.
  const transfer = round2(await queries.computeTransferBalance(account.id, db));
  const cash = round2(account.current_balance - transfer);
  return { cash_balance: cash, transfer_balance: transfer };
};

/**
 * Convierte un medio único en el desglose que espera insertMovementWithBalance.
 * @param {'CASH'|'TRANSFER'} method - Medio declarado.
 * @param {number} amount - Monto total.
 * @returns {{amountCash:number, amountTransfer:number}}
 */
const splitByMethod = (method, amount) => {
  if (method !== "CASH" && method !== "TRANSFER") {
    throw err(
      422,
      "payment_method debe ser CASH o TRANSFER.",
      "INVALID_PAYMENT_METHOD",
    );
  }
  return {
    amountCash: method === "CASH" ? amount : 0,
    amountTransfer: method === "TRANSFER" ? amount : 0,
  };
};

const METHOD_LABEL = { CASH: "efectivo", TRANSFER: "transferencia" };

/**
 * Rechaza con 409 INSUFFICIENT_METHOD_BALANCE si algún medio no alcanza.
 * @param {object} client - Client de la transacción (cuenta ya bloqueada).
 * @param {{id:string, current_balance:number}} account - Cuenta bloqueada.
 * @param {{CASH?:number, TRANSFER?:number}} required - Monto requerido por medio.
 * @returns {Promise<{cash_balance:number, transfer_balance:number}>}
 */
const assertMethodBalances = async (client, account, required) => {
  const balances = await getMethodBalances(client, account);
  const available = {
    CASH: balances.cash_balance,
    TRANSFER: balances.transfer_balance,
  };
  for (const method of ["CASH", "TRANSFER"]) {
    const need = round2(required[method] || 0);
    if (need > 0 && need > available[method]) {
      throw err(
        409,
        `Saldo insuficiente en ${METHOD_LABEL[method]}. Disponible: ${available[method]}. Monto requerido: ${need}.`,
        "INSUFFICIENT_METHOD_BALANCE",
      );
    }
  }
  return balances;
};

/**
 * Bloquea la cuenta (mismo FOR UPDATE que current_balance) y valida que el
 * medio de origen tenga saldo, para conversiones COMPANY o egresos por medio.
 * @param {object} client - Client de una transacción abierta.
 * @param {string} accountId - Cuenta de Caja General.
 * @param {'CASH'|'TRANSFER'} method - Medio de origen.
 * @param {number} amount - Monto a debitar de ese medio.
 * @returns {Promise<{cash_balance:number, transfer_balance:number}>}
 */
const assertMethodAvailable = async (client, accountId, method, amount) => {
  const account = await queries.lockAndGetBalance(client, accountId);
  if (!account) throw err(404, "Cuenta no encontrada.", "NOT_FOUND");
  return assertMethodBalances(client, account, { [method]: amount });
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

  // 3b) Todo egreso debe declarar su medio (efectivo/transferencia) y se
  // valida el saldo de cada medio bajo el mismo lock FOR UPDATE (issue #93).
  const outSplit = direction === "OUT";
  if (outSplit) {
    if (amountCash === undefined && amountTransfer === undefined) {
      throw err(
        422,
        "Todo egreso de Caja General debe declarar su medio de pago (efectivo o transferencia).",
        "PAYMENT_METHOD_REQUIRED",
      );
    }
    if (round2((amountCash || 0) + (amountTransfer || 0)) !== round2(amount)) {
      throw err(
        422,
        "amount debe coincidir con amount_cash + amount_transfer.",
        "INVALID_SPLIT_TOTAL",
      );
    }
    await assertMethodBalances(client, account, {
      CASH: amountCash,
      TRANSFER: amountTransfer,
    });
  }

  let splitCash = 0;
  let splitTransfer = 0;
  if (direction === "IN") {
    splitCash = amountCash ?? amount;
    splitTransfer = amountTransfer ?? 0;
  } else if (outSplit) {
    splitCash = amountCash || 0;
    splitTransfer = amountTransfer || 0;
  }

  // 4) Insertar movimiento.
  const movement = await queries.insertMovement(client, {
    cashAccountId,
    movementType,
    direction,
    amount,
    amountCash: splitCash,
    amountTransfer: splitTransfer,
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
    ...(await getMethodBalances(undefined, account)),
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
  let hasSplit = hasValue(body.amount_cash) || hasValue(body.amount_transfer);
  let amountCash = hasSplit ? round2(parseFloat(body.amount_cash) || 0) : null;
  let amountTransfer = hasSplit
    ? round2(parseFloat(body.amount_transfer) || 0)
    : null;
  // Formato simple: amount + payment_method (un solo medio).
  if (!hasSplit && hasValue(body.payment_method)) {
    const total = round2(parseFloat(body.amount));
    ({ amountCash, amountTransfer } = splitByMethod(body.payment_method, total));
    hasSplit = true;
  }
  if (direction === "OUT" && !hasSplit) {
    throw err(
      422,
      "Todo egreso debe declarar su medio: payment_method o amount_cash/amount_transfer.",
      "PAYMENT_METHOD_REQUIRED",
    );
  }
  const amount = hasSplit
    ? round2(amountCash + amountTransfer)
    : round2(parseFloat(body.amount));

  if (!(amount > 0)) {
    throw err(422, "amount debe ser > 0.", "INVALID_AMOUNT");
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
  getMethodBalances,
  splitByMethod,
  assertMethodAvailable,
  resolveDirection,
  FIXED_DIRECTION,
  PUBLIC_MOVEMENT_TYPES,
};
