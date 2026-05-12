-- ============================================================
--  MIGRACIÓN 007 — Repetición anual de feriados
-- ============================================================
ALTER TABLE public.holidays
ADD COLUMN IF NOT EXISTS repeats_annually BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill seguro para mantener comportamiento de feriados fijos existentes.
UPDATE public.holidays
SET repeats_annually = CASE
  WHEN type = 'EXTRAORDINARY' THEN FALSE
  ELSE TRUE
END
WHERE repeats_annually IS DISTINCT FROM CASE
  WHEN type = 'EXTRAORDINARY' THEN FALSE
  ELSE TRUE
END;

CREATE INDEX IF NOT EXISTS idx_holidays_active_repeats_annually
ON holidays(active, repeats_annually);
