-- Migración: destino del sobrepago en un cambio de plan (P10 / issue #45).
--
-- Contexto: si el cliente ya pagó más que el total del nuevo plan, el saldo
-- recalculado es negativo. Antes ese excedente se descartaba (el crédito se
-- cancelaba con settlement_amount = 0 y el dinero no quedaba registrado).
-- Ahora el cliente elige qué hacer con el excedente:
--   · CREDIT_BALANCE → queda como saldo a favor en credits.credit_balance
--     (sin movimiento de caja).
--   · REFUND         → se le devuelve en efectivo desde la caja operativa
--     activa de la jornada (refund_cash_session_id).
--
-- Cambio aditivo e idempotente:
--   · Columnas nuevas con DEFAULT / NULL: los registros existentes no cambian.
--   · No modifica ni borra datos existentes.
--
-- Reversión (manual, solo si se revierte el código que la usa):
--   ALTER TABLE credit_plan_changes DROP COLUMN IF EXISTS refund_cash_session_id;
--   ALTER TABLE credit_plan_changes DROP COLUMN IF EXISTS excess_disposition;
--   ALTER TABLE credit_plan_changes DROP COLUMN IF EXISTS excess_amount;
--   ALTER TABLE credits DROP COLUMN IF EXISTS credit_balance;
-- =============================================================================

ALTER TABLE credits
  ADD COLUMN IF NOT EXISTS credit_balance NUMERIC(12,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credits_credit_balance_check'
  ) THEN
    ALTER TABLE credits
      ADD CONSTRAINT credits_credit_balance_check CHECK (credit_balance >= 0);
  END IF;
END $$;

ALTER TABLE credit_plan_changes
  ADD COLUMN IF NOT EXISTS excess_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE credit_plan_changes
  ADD COLUMN IF NOT EXISTS excess_disposition VARCHAR(20) NULL;

ALTER TABLE credit_plan_changes
  ADD COLUMN IF NOT EXISTS refund_cash_session_id UUID NULL REFERENCES cash_sessions(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credit_plan_changes_excess_disposition_check'
  ) THEN
    ALTER TABLE credit_plan_changes
      ADD CONSTRAINT credit_plan_changes_excess_disposition_check
        CHECK (excess_disposition IS NULL OR excess_disposition IN ('CREDIT_BALANCE', 'REFUND'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_credit_plan_changes_refund_session
  ON credit_plan_changes (refund_cash_session_id)
  WHERE refund_cash_session_id IS NOT NULL;
