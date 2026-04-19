-- ============================================================
--  MIGRACIÓN 003 — Enganche y adelanto de cuotas
--  Agrega soporte para down_payment en créditos SALE,
--  original_due_date en cuotas (auditoría de corrimientos)
--  y tabla de registro de enganches para caja.
-- ============================================================

-- ── 1. credits: columnas de enganche ─────────────────────────
-- down_payment: monto abonado como enganche al momento de la venta.
--   Reduce el capital sobre el que se calculan las cuotas.
-- down_payment_method / _transfer_reference: cómo se cobró el enganche.
ALTER TABLE public.credits
    ADD COLUMN down_payment            NUMERIC(12,2)  NOT NULL DEFAULT 0
        CONSTRAINT credits_down_payment_check CHECK (down_payment >= 0),
    ADD COLUMN down_payment_method     VARCHAR(15)    NULL
        CONSTRAINT credits_down_payment_method_check
        CHECK (down_payment_method IN ('CASH','TRANSFER')),
    ADD COLUMN down_payment_transfer_reference VARCHAR(100) NULL;

-- ── 2. installments: columna original_due_date ───────────────
-- Se completa la primera vez que la fecha de vencimiento
-- es corrida por un pago adelantado; permite auditar el
-- cronograma original vs. el vigente.
ALTER TABLE public.installments
    ADD COLUMN original_due_date DATE NULL;

-- ── 3. credit_down_payments ───────────────────────────────────
-- Registra los enganches aprobados para trazabilidad en caja.
-- Es independiente de payments (los enganches no están ligados
-- a ninguna cuota en particular).
CREATE TABLE public.credit_down_payments (
    id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_id          UUID            NOT NULL REFERENCES credits(id) ON UPDATE CASCADE,
    amount             NUMERIC(12,2)   NOT NULL
                           CONSTRAINT credit_down_payments_amount_check CHECK (amount > 0),
    payment_method     VARCHAR(15)     NOT NULL
                           CONSTRAINT credit_down_payments_payment_method_check
                           CHECK (payment_method IN ('CASH','TRANSFER')),
    transfer_reference VARCHAR(100)    NULL,
    approved_by        UUID            NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
    created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_down_payments_credit ON credit_down_payments(credit_id);
CREATE INDEX idx_credit_down_payments_date   ON credit_down_payments(created_at);
