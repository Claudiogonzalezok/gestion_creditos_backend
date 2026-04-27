-- ============================================================
--  MIGRACIÓN 002 — Categorías de gastos y campos adicionales
--  en la tabla expenses
-- ============================================================

-- ── 1. Tabla de categorías de gastos ─────────────────────────
CREATE TABLE public.expense_categories (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(100) NOT NULL UNIQUE,
    active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 2. Categorías por defecto ─────────────────────────────────
INSERT INTO public.expense_categories (name) VALUES
    ('Alquiler'),
    ('Servicios'),
    ('Sueldos externos'),
    ('Insumos'),
    ('Otros');

-- ── 3. Columnas nuevas en expenses ───────────────────────────
ALTER TABLE public.expenses
    ADD COLUMN category_id  UUID REFERENCES public.expense_categories(id),
    ADD COLUMN expense_date DATE NOT NULL DEFAULT CURRENT_DATE;
