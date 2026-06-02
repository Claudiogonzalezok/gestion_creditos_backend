// Queries del módulo cashAccounts.
//
// Reglas de invariante (recordar):
//   · cash_account_movements es la FUENTE DE VERDAD contable.
//   · cash_accounts.current_balance es un CACHE: se mantiene transaccional-
//     mente y debe poder reconstruirse en cualquier momento con
//     recomputeBalance().
//   · Toda inserción de movimiento debe pasar por insertMovementAndUpdateBalance
//     (lock FOR UPDATE + check de saldo + insert + update del cache) en la
//     misma transacción. Nunca actualizar current_balance "a mano".

const pool = require('../../config/db');

// ── Cuentas ────────────────────────────────────────────────────────────────

const findAllActive = async (db = pool) => {
  const r = await db.query(
    `SELECT id, name, type, is_active, current_balance::float8 AS current_balance, created_at
     FROM cash_accounts
     WHERE is_active = TRUE
     ORDER BY type, name`,
  );
  return r.rows;
};

const findById = async (id, db = pool) => {
  const r = await db.query(
    `SELECT id, name, type, is_active, current_balance::float8 AS current_balance, created_at
     FROM cash_accounts
     WHERE id = $1`,
    [id],
  );
  return r.rows[0] || null;
};

const findGeneralCashAccount = async (db = pool) => {
  const r = await db.query(
    `SELECT id, name, type, is_active, current_balance::float8 AS current_balance, created_at
     FROM cash_accounts
     WHERE type = 'GENERAL_CASH' AND is_active = TRUE
     ORDER BY created_at
     LIMIT 1`,
  );
  return r.rows[0] || null;
};

// Lock fila de la cuenta y devuelve current_balance fresco. Debe llamarse
// dentro de una transacción (recibe client, no pool).
const lockAndGetBalance = async (client, accountId) => {
  const r = await client.query(
    `SELECT id, current_balance::float8 AS current_balance
     FROM cash_accounts
     WHERE id = $1
     FOR UPDATE`,
    [accountId],
  );
  return r.rows[0] || null;
};

// ── Movimientos ────────────────────────────────────────────────────────────

const MOVEMENT_FIELDS = `
  id, cash_account_id, movement_type, direction,
  amount::float8 AS amount, description, beneficiary_name,
  reference_type, reference_id, created_by, created_at
`;

const findMovements = async ({
  accountId, movementType, direction, from, to, limit, offset,
}, db = pool) => {
  const conds = ['cash_account_id = $1'];
  const params = [accountId];
  if (movementType) { conds.push(`movement_type = $${params.length + 1}`); params.push(movementType); }
  if (direction)    { conds.push(`direction = $${params.length + 1}`);     params.push(direction); }
  if (from)         { conds.push(`created_at >= $${params.length + 1}`);   params.push(from); }
  if (to)           { conds.push(`created_at <  $${params.length + 1}`);   params.push(to); }
  const limitParam  = params.length + 1; params.push(limit);
  const offsetParam = params.length + 1; params.push(offset);

  const r = await db.query(
    `SELECT ${MOVEMENT_FIELDS}
     FROM cash_account_movements
     WHERE ${conds.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );
  return r.rows;
};

const countMovements = async ({
  accountId, movementType, direction, from, to,
}, db = pool) => {
  const conds = ['cash_account_id = $1'];
  const params = [accountId];
  if (movementType) { conds.push(`movement_type = $${params.length + 1}`); params.push(movementType); }
  if (direction)    { conds.push(`direction = $${params.length + 1}`);     params.push(direction); }
  if (from)         { conds.push(`created_at >= $${params.length + 1}`);   params.push(from); }
  if (to)           { conds.push(`created_at <  $${params.length + 1}`);   params.push(to); }
  const r = await db.query(
    `SELECT COUNT(*)::int AS total
     FROM cash_account_movements
     WHERE ${conds.join(' AND ')}`,
    params,
  );
  return r.rows[0].total;
};

const findMovementById = async (id, db = pool) => {
  const r = await db.query(
    `SELECT ${MOVEMENT_FIELDS}
     FROM cash_account_movements WHERE id = $1`,
    [id],
  );
  return r.rows[0] || null;
};

// Busca un movimiento por (reference_type, reference_id, movement_type).
// movementType es opcional para acotar a un tipo específico (ej: DROP_IN).
const findMovementByReference = async ({
  referenceType, referenceId, movementType,
}, db = pool) => {
  const conds = ['reference_type = $1', 'reference_id = $2'];
  const params = [referenceType, referenceId];
  if (movementType) {
    conds.push(`movement_type = $${params.length + 1}`);
    params.push(movementType);
  }
  const r = await db.query(
    `SELECT ${MOVEMENT_FIELDS}
     FROM cash_account_movements
     WHERE ${conds.join(' AND ')}
     ORDER BY created_at
     LIMIT 1`,
    params,
  );
  return r.rows[0] || null;
};

// Inserta el movimiento sin tocar current_balance. Pensado para uso interno
// del service (que ya hizo FOR UPDATE + validó saldo y va a UPDATE el cache).
const insertMovement = async (client, {
  cashAccountId, movementType, direction, amount,
  description, beneficiaryName, referenceType, referenceId, createdBy,
}) => {
  const r = await client.query(
    `INSERT INTO cash_account_movements
       (cash_account_id, movement_type, direction, amount, description,
        beneficiary_name, reference_type, reference_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${MOVEMENT_FIELDS}`,
    [
      cashAccountId, movementType, direction, amount,
      description || null, beneficiaryName || null,
      referenceType || null, referenceId || null, createdBy,
    ],
  );
  return r.rows[0];
};

const updateCurrentBalance = async (client, accountId, newBalance) => {
  await client.query(
    `UPDATE cash_accounts SET current_balance = $2 WHERE id = $1`,
    [accountId, newBalance],
  );
};

// ── Balance derivado (auditoría / reparación) ──────────────────────────────

// Calcula el saldo real desde los movimientos (fuente de verdad). Se usa para
// auditoría y para validar drift contra current_balance.
const computeBalanceFromMovements = async (accountId, db = pool) => {
  const r = await db.query(
    `SELECT COALESCE(SUM(
       CASE WHEN direction = 'IN' THEN amount ELSE -amount END
     ), 0)::float8 AS balance
     FROM cash_account_movements
     WHERE cash_account_id = $1`,
    [accountId],
  );
  return r.rows[0].balance;
};

// Helper de reparación: recalcula y persiste current_balance desde los
// movimientos. Idempotente. Solo para uso interno (jobs, scripts), no expuesto
// como endpoint. Debe ejecutarse en una transacción con lock previo de la
// cuenta para evitar carreras con inserts concurrentes.
const recomputeBalance = async (client, accountId) => {
  const r = await client.query(
    `UPDATE cash_accounts ca
       SET current_balance = COALESCE((
         SELECT SUM(CASE WHEN m.direction = 'IN' THEN m.amount ELSE -m.amount END)
           FROM cash_account_movements m
          WHERE m.cash_account_id = ca.id
       ), 0)
     WHERE ca.id = $1
     RETURNING current_balance::float8 AS current_balance`,
    [accountId],
  );
  return r.rows[0] ? r.rows[0].current_balance : null;
};

module.exports = {
  // cuentas
  findAllActive,
  findById,
  findGeneralCashAccount,
  lockAndGetBalance,
  // movimientos
  findMovements,
  countMovements,
  findMovementById,
  findMovementByReference,
  insertMovement,
  updateCurrentBalance,
  // balance derivado
  computeBalanceFromMovements,
  recomputeBalance,
};
