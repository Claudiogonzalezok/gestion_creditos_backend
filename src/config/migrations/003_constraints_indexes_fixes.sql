-- ── Constraints de integridad financiera ─────────────────────
-- DROP previo por si la DB existente tiene la versión laxa del constraint
ALTER TABLE installments
  DROP CONSTRAINT IF EXISTS installments_amount_paid_check;
ALTER TABLE installments
  ADD CONSTRAINT installments_amount_paid_check
    CHECK (amount_paid <= amount_due);

ALTER TABLE credits
  DROP CONSTRAINT IF EXISTS credits_down_payment_check;
ALTER TABLE credits
  ADD CONSTRAINT credits_down_payment_check
    CHECK (down_payment IS NULL OR down_payment < total_amount);

ALTER TABLE credits
  DROP CONSTRAINT IF EXISTS credits_prepaid_installments_check;
ALTER TABLE credits
  ADD CONSTRAINT credits_prepaid_installments_check
    CHECK (prepaid_installments IS NULL OR prepaid_installments < installments_count);

-- ── Índices compuestos para queries frecuentes ────────────────
CREATE INDEX IF NOT EXISTS idx_installments_credit_status
  ON installments(credit_id, status);

CREATE INDEX IF NOT EXISTS idx_payments_installment_status
  ON payments(installment_id, status);

CREATE INDEX IF NOT EXISTS idx_expenses_date_user
  ON expenses(expense_date, created_by);

-- ── Corrección de typo: total_egreses → total_egresos ─────────
ALTER TABLE cash_registers
  RENAME COLUMN total_egreses TO total_egresos;
