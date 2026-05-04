-- ============================================================
--  MIGRACIÓN 002 — Ajustes críticos para flujo SALE
--  - Tasas por producto (product_rates)
--  - Enganche / down payment
--  - Snapshot de tasa histórica por producto
--  - Auditoría de corrimiento de cuotas
-- ============================================================

CREATE TABLE IF NOT EXISTS public.product_rates (
    id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id         UUID            NOT NULL REFERENCES products(id) ON UPDATE CASCADE,
    payment_frequency  VARCHAR(15)     NOT NULL
                           CHECK (payment_frequency IN ('WEEKLY','BIWEEKLY','MONTHLY')),
    installments_count SMALLINT        NOT NULL CHECK (installments_count > 0),
    rate               NUMERIC(6,4)    NOT NULL CHECK (rate > 0),
    active             BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_rates_unique_combo
    ON public.product_rates(product_id, payment_frequency, installments_count);
CREATE INDEX IF NOT EXISTS idx_product_rates_product ON public.product_rates(product_id);
CREATE INDEX IF NOT EXISTS idx_product_rates_active  ON public.product_rates(active);

ALTER TABLE public.credits
    ADD COLUMN IF NOT EXISTS down_payment NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS down_payment_method VARCHAR(15) NULL,
    ADD COLUMN IF NOT EXISTS down_payment_transfer_reference VARCHAR(100) NULL;

ALTER TABLE public.credit_products
    ADD COLUMN IF NOT EXISTS historical_rate NUMERIC(6,4) NULL;

ALTER TABLE public.installments
    ADD COLUMN IF NOT EXISTS original_due_date DATE NULL;

CREATE TABLE IF NOT EXISTS public.credit_down_payments (
    id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_id          UUID            NOT NULL REFERENCES credits(id) ON UPDATE CASCADE,
    amount             NUMERIC(12,2)   NOT NULL CHECK (amount > 0),
    payment_method     VARCHAR(15)     NOT NULL CHECK (payment_method IN ('CASH','TRANSFER')),
    transfer_reference VARCHAR(100)    NULL,
    approved_by        UUID            NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
    payment_type       VARCHAR(30)     NOT NULL DEFAULT 'DOWN_PAYMENT'
                           CHECK (payment_type IN ('DOWN_PAYMENT','PREPAID_INSTALLMENT')),
    created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_down_payments_credit ON public.credit_down_payments(credit_id);
CREATE INDEX IF NOT EXISTS idx_credit_down_payments_date   ON public.credit_down_payments(created_at);
