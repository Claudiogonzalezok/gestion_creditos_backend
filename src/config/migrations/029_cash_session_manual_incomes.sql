-- ── 029: Ingresos manuales de caja operativa ───────────────────────────────
-- Registra entradas manuales del turno sin crear operaciones comerciales.
-- Se imputan a cash_sessions para mantener la trazabilidad del modelo V4.
CREATE TABLE IF NOT EXISTS public.cash_session_manual_incomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_session_id UUID NOT NULL REFERENCES public.cash_sessions(id),
    amount NUMERIC(12, 2) NOT NULL CONSTRAINT cash_session_manual_incomes_amount_check CHECK (amount > 0),
    payment_method VARCHAR(15) NOT NULL CONSTRAINT cash_session_manual_incomes_method_check CHECK (payment_method IN ('CASH', 'TRANSFER')),
    description VARCHAR(255) NOT NULL,
    receipt_reference VARCHAR(120) NULL,
    created_by UUID NOT NULL REFERENCES public.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_session_manual_incomes_session ON public.cash_session_manual_incomes(cash_session_id, created_at DESC);