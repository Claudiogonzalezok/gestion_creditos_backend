-- ── 022: Movimientos de conversión de caja ───────────────────────────────────
-- Registra conversiones internas entre efectivo y transferencia para trazabilidad
-- de caja diaria y caja de empresa.

CREATE TABLE IF NOT EXISTS public.cash_conversions (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    register_date   DATE          NOT NULL,
    criteria        VARCHAR(20)   NOT NULL
                      CONSTRAINT cash_conversions_criteria_check
                      CHECK (criteria IN ('DAILY', 'COMPANY')),
    source_method   VARCHAR(15)   NOT NULL
                      CONSTRAINT cash_conversions_source_method_check
                      CHECK (source_method IN ('CASH', 'TRANSFER')),
    target_method   VARCHAR(15)   NOT NULL
                      CONSTRAINT cash_conversions_target_method_check
                      CHECK (target_method IN ('CASH', 'TRANSFER')),
    amount          NUMERIC(12,2) NOT NULL
                      CONSTRAINT cash_conversions_amount_check CHECK (amount > 0),
    notes           TEXT,
    created_by      UUID          NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT cash_conversions_methods_must_differ CHECK (source_method <> target_method)
);

CREATE INDEX IF NOT EXISTS idx_cash_conversions_register_date
  ON cash_conversions(register_date);

CREATE INDEX IF NOT EXISTS idx_cash_conversions_criteria
  ON cash_conversions(criteria);
