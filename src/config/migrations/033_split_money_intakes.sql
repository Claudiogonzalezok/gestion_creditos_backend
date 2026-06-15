-- ── 033: desglose por medio para todos los ingresos de dinero ───────────────
-- Extiende el mismo criterio de payments mixtos a enganches, cuotas adelantadas
-- e ingresos manuales de caja.
-- Pre-operaciones: el dinero se declara al crear la operación y se imputa recién
-- al aprobar, por eso el desglose debe persistirse en credits.
ALTER TABLE
  credits
ADD
  COLUMN IF NOT EXISTS down_payment_cash NUMERIC(12, 2) NOT NULL DEFAULT 0 CONSTRAINT credits_down_payment_cash_check CHECK (down_payment_cash >= 0),
ADD
  COLUMN IF NOT EXISTS down_payment_transfer NUMERIC(12, 2) NOT NULL DEFAULT 0 CONSTRAINT credits_down_payment_transfer_check CHECK (down_payment_transfer >= 0),
ADD
  COLUMN IF NOT EXISTS prepaid_installments_cash NUMERIC(12, 2) NOT NULL DEFAULT 0 CONSTRAINT credits_prepaid_installments_cash_check CHECK (prepaid_installments_cash >= 0),
ADD
  COLUMN IF NOT EXISTS prepaid_installments_transfer NUMERIC(12, 2) NOT NULL DEFAULT 0 CONSTRAINT credits_prepaid_installments_transfer_check CHECK (prepaid_installments_transfer >= 0);

UPDATE
  credits
SET
  down_payment_cash = down_payment,
  down_payment_transfer = 0
WHERE
  down_payment_method = 'CASH'
  AND down_payment > 0
  AND down_payment_cash = 0
  AND down_payment_transfer = 0;

UPDATE
  credits
SET
  down_payment_transfer = down_payment,
  down_payment_cash = 0
WHERE
  down_payment_method = 'TRANSFER'
  AND down_payment > 0
  AND down_payment_cash = 0
  AND down_payment_transfer = 0;

ALTER TABLE
  credits DROP CONSTRAINT IF EXISTS credits_down_payment_method_check;

ALTER TABLE
  credits
ADD
  CONSTRAINT credits_down_payment_method_check CHECK (
    down_payment_method IS NULL
    OR down_payment_method IN ('CASH', 'TRANSFER', 'MIXED')
  );

ALTER TABLE
  credits DROP CONSTRAINT IF EXISTS credits_prepaid_installments_method_check;

ALTER TABLE
  credits
ADD
  CONSTRAINT credits_prepaid_installments_method_check CHECK (
    prepaid_installments_method IS NULL
    OR prepaid_installments_method IN ('CASH', 'TRANSFER', 'MIXED')
  );

-- Movimientos iniciales aprobados: caja debe poder sumar por medio real.
ALTER TABLE
  credit_down_payments
ADD
  COLUMN IF NOT EXISTS amount_cash NUMERIC(12, 2) NOT NULL DEFAULT 0 CONSTRAINT credit_down_payments_amount_cash_check CHECK (amount_cash >= 0),
ADD
  COLUMN IF NOT EXISTS amount_transfer NUMERIC(12, 2) NOT NULL DEFAULT 0 CONSTRAINT credit_down_payments_amount_transfer_check CHECK (amount_transfer >= 0);

UPDATE
  credit_down_payments
SET
  amount_cash = amount,
  amount_transfer = 0
WHERE
  payment_method = 'CASH'
  AND amount_cash = 0
  AND amount_transfer = 0;

UPDATE
  credit_down_payments
SET
  amount_transfer = amount,
  amount_cash = 0
WHERE
  payment_method = 'TRANSFER'
  AND amount_cash = 0
  AND amount_transfer = 0;

ALTER TABLE
  credit_down_payments DROP CONSTRAINT IF EXISTS credit_down_payments_payment_method_check;

ALTER TABLE
  credit_down_payments
ADD
  CONSTRAINT credit_down_payments_payment_method_check CHECK (payment_method IN ('CASH', 'TRANSFER', 'MIXED'));

ALTER TABLE
  credit_down_payments DROP CONSTRAINT IF EXISTS credit_down_payments_amount_split_check;

ALTER TABLE
  credit_down_payments
ADD
  CONSTRAINT credit_down_payments_amount_split_check CHECK (amount_cash + amount_transfer = amount);

-- Ingresos manuales de caja.
ALTER TABLE
  cash_session_manual_incomes
ADD
  COLUMN IF NOT EXISTS amount_cash NUMERIC(12, 2) NOT NULL DEFAULT 0 CONSTRAINT cash_session_manual_incomes_amount_cash_check CHECK (amount_cash >= 0),
ADD
  COLUMN IF NOT EXISTS amount_transfer NUMERIC(12, 2) NOT NULL DEFAULT 0 CONSTRAINT cash_session_manual_incomes_amount_transfer_check CHECK (amount_transfer >= 0);

UPDATE
  cash_session_manual_incomes
SET
  amount_cash = amount,
  amount_transfer = 0
WHERE
  payment_method = 'CASH'
  AND amount_cash = 0
  AND amount_transfer = 0;

UPDATE
  cash_session_manual_incomes
SET
  amount_transfer = amount,
  amount_cash = 0
WHERE
  payment_method = 'TRANSFER'
  AND amount_cash = 0
  AND amount_transfer = 0;

ALTER TABLE
  cash_session_manual_incomes DROP CONSTRAINT IF EXISTS cash_session_manual_incomes_method_check;

ALTER TABLE
  cash_session_manual_incomes
ADD
  CONSTRAINT cash_session_manual_incomes_method_check CHECK (payment_method IN ('CASH', 'TRANSFER', 'MIXED'));

ALTER TABLE
  cash_session_manual_incomes DROP CONSTRAINT IF EXISTS cash_session_manual_incomes_amount_split_check;

ALTER TABLE
  cash_session_manual_incomes
ADD
  CONSTRAINT cash_session_manual_incomes_amount_split_check CHECK (amount_cash + amount_transfer = amount);