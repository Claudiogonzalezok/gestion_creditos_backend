-- ── 034: desglose por medio en entradas de Caja General ────────────────────
-- Caja General puede recibir dinero por ADJUSTMENT IN manual y por DROP_IN
-- automático desde caja operativa. Persistimos el medio real para auditoría.
ALTER TABLE
  cash_account_movements
ADD
  COLUMN IF NOT EXISTS amount_cash NUMERIC(12, 2) NOT NULL DEFAULT 0 CONSTRAINT cash_account_movements_amount_cash_check CHECK (amount_cash >= 0),
ADD
  COLUMN IF NOT EXISTS amount_transfer NUMERIC(12, 2) NOT NULL DEFAULT 0 CONSTRAINT cash_account_movements_amount_transfer_check CHECK (amount_transfer >= 0);

-- DROP_IN puede reconstruirse desde el drop original, que sí conoce el medio.
UPDATE
  cash_account_movements cam
SET
  amount_cash = CASE
    WHEN csd.payment_method = 'CASH' THEN cam.amount
    ELSE 0
  END,
  amount_transfer = CASE
    WHEN csd.payment_method = 'TRANSFER' THEN cam.amount
    ELSE 0
  END
FROM
  cash_session_drops csd
WHERE
  cam.movement_type = 'DROP_IN'
  AND cam.reference_type = 'CASH_SESSION_DROP'
  AND cam.reference_id = csd.id
  AND cam.amount_cash = 0
  AND cam.amount_transfer = 0;

-- Entradas manuales legacy sin desglose explícito: se asumen efectivo para no
-- perder consistencia amount_cash + amount_transfer = amount en direction IN.
UPDATE
  cash_account_movements
SET
  amount_cash = amount,
  amount_transfer = 0
WHERE
  direction = 'IN'
  AND amount_cash = 0
  AND amount_transfer = 0;

ALTER TABLE
  cash_account_movements DROP CONSTRAINT IF EXISTS cash_account_movements_amount_split_check;

ALTER TABLE
  cash_account_movements
ADD
  CONSTRAINT cash_account_movements_amount_split_check CHECK (
    (
      direction = 'IN'
      AND amount_cash + amount_transfer = amount
    )
    OR (
      direction = 'OUT'
      AND amount_cash = 0
      AND amount_transfer = 0
    )
  );