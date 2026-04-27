-- ============================================================
--  MIGRACIÓN 005 — Migrar name → description en products
-- ============================================================

-- ── 1. Copiar name a description donde esté vacío ─────────────
UPDATE public.products SET description = name WHERE description IS NULL OR description = '';

-- ── 2. Aplicar restricciones a description ────────────────────
ALTER TABLE public.products
    ALTER COLUMN description SET NOT NULL,
    ADD CONSTRAINT products_description_unique UNIQUE (description);

-- ── 3. Eliminar la columna name ───────────────────────────────
ALTER TABLE public.products DROP COLUMN name;
