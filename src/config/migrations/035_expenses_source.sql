-- ── 035: origen del gasto (caja del día vs Caja General) ────────────────────
-- Un gasto puede salir de la caja operativa de la jornada (DAILY, default,
-- comportamiento histórico) o directamente de Caja General (COMPANY), sin
-- pasar por cash_sessions. cash_session_id ya era nullable (migración 024).
ALTER TABLE
  public.expenses
ADD
  COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'DAILY' CONSTRAINT expenses_source_check CHECK (source IN ('DAILY', 'COMPANY'));