-- ============================================================
--  MIGRACIÓN 006 — Feriados y recálculo controlado de cuotas
-- ============================================================
CREATE TABLE IF NOT EXISTS public.holidays (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL,
    name VARCHAR(150) NOT NULL,
    type VARCHAR(20) NOT NULL DEFAULT 'EXTRAORDINARY' CONSTRAINT holidays_type_check CHECK (
        type IN ('EXTRAORDINARY', 'NATIONAL', 'LOCAL', 'BANKING')
    ),
    affects_due_dates BOOLEAN NOT NULL DEFAULT TRUE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT holidays_unique_date_type UNIQUE (date, type)
);

CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);

CREATE INDEX IF NOT EXISTS idx_holidays_active_affects ON holidays(active, affects_due_dates);