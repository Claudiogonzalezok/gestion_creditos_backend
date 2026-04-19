-- ============================================================
--  MIGRACIÓN 002 — Tasas de interés por producto
--  Permite configurar coeficientes específicos por producto,
--  frecuencia y cantidad de cuotas.
-- ============================================================

-- ── 1. product_rates ─────────────────────────────────────────
CREATE TABLE public.product_rates (
    id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id         UUID            NOT NULL REFERENCES products(id) ON UPDATE CASCADE,
    payment_frequency  VARCHAR(15)     NOT NULL
                           CONSTRAINT product_rates_payment_frequency_check
                           CHECK (payment_frequency IN ('WEEKLY','BIWEEKLY','MONTHLY')),
    installments_count SMALLINT        NOT NULL
                           CONSTRAINT product_rates_installments_count_check
                           CHECK (installments_count > 0),
    rate               NUMERIC(6,4)    NOT NULL
                           CONSTRAINT product_rates_rate_check CHECK (rate > 0),
    active             BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT product_rates_unique
        UNIQUE (product_id, payment_frequency, installments_count)
);

CREATE INDEX idx_product_rates_product ON product_rates(product_id);
CREATE INDEX idx_product_rates_active  ON product_rates(active);

-- ── 2. historical_rate en credit_products ────────────────────
-- Se congela al momento de aprobar el crédito (no al generarlo).
ALTER TABLE public.credit_products
    ADD COLUMN historical_rate NUMERIC(6,4) NULL;
