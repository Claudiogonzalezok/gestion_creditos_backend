-- ── 044: egreso del préstamo (LOAN) en caja ─────────────────────────────────
-- Hasta ahora, aprobar un crédito LOAN generaba cuotas pero no registraba en
-- ninguna caja la salida de efectivo entregada al cliente. Esta migración
-- agrega el vínculo a la caja operativa de la jornada (rama DAILY). La rama
-- COMPANY (Caja General) queda contemplada en el CHECK para no requerir una
-- migración nueva cuando se implemente, pero todavía no tiene lógica de
-- servicio asociada.
ALTER TABLE
  public.credits
ADD
  COLUMN IF NOT EXISTS disbursement_source VARCHAR(10) NOT NULL DEFAULT 'DAILY'
    CONSTRAINT credits_disbursement_source_check CHECK (disbursement_source IN ('DAILY', 'COMPANY'));

ALTER TABLE
  public.credits
ADD
  COLUMN IF NOT EXISTS disbursement_cash_session_id UUID NULL
    REFERENCES public.cash_sessions(id) ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS idx_credits_disbursement_cash_session
  ON public.credits(disbursement_cash_session_id)
  WHERE disbursement_cash_session_id IS NOT NULL;
