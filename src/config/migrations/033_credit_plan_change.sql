-- ── 033: Cambio de plan de crédito ───────────────────────────────────────────
-- Permite recalcular un crédito LOAN ACTIVE a un plan más corto (tasa más
-- favorable) dejando UNA cuota viva. NO es refinanciación: no se crea crédito
-- nuevo, no se mueven fechas, no se crean cuotas. Ver docs/cambio-de-plan-analisis.md.
--
-- Reversible: ver DOWN al final.

-- ── 1. Nuevo estado de cuota: PLAN_CHANGE_CANCELLED ───────────────────────────
-- Cuotas futuras anuladas por un cambio de plan. Estado PROPIO (negocio prohibió
-- reutilizar REFINANCED). Debe tratarse como "no vigente" en saldos/planillas/
-- mora/reportes (igual que PAID/REFINANCED).
-- El valor ('PLAN_CHANGE_CANCELLED' = 21 chars) supera el VARCHAR(20) original
-- de la columna, así que se ensancha primero.
ALTER TABLE installments ALTER COLUMN status TYPE VARCHAR(30);
ALTER TABLE installments
  DROP CONSTRAINT IF EXISTS installments_status_check;
ALTER TABLE installments
  ADD CONSTRAINT installments_status_check
    CHECK (status IN ('PENDING','PAID','PARTIAL','OVERDUE','REFINANCED','PLAN_CHANGE_CANCELLED'));

-- ── 2. Nuevo settlement_type: PLAN_CHANGE ─────────────────────────────────────
-- Cuando el recálculo da saldo <= 0, el crédito se cancela automáticamente con
-- este tipo de liquidación.
ALTER TABLE credits
  DROP CONSTRAINT IF EXISTS credits_settlement_type_check;
ALTER TABLE credits
  ADD CONSTRAINT credits_settlement_type_check
    CHECK (settlement_type IN ('NORMAL','EARLY_CANCELLATION','PLAN_CHANGE'));

-- ── 3. Tabla de trazabilidad credit_plan_changes ──────────────────────────────
-- Registro inmutable por cada cambio de plan ejecutado. Captura el snapshot
-- financiero antes/después. Las cuotas pagadas y los pagos históricos no se tocan.
CREATE TABLE IF NOT EXISTS credit_plan_changes (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_id                   UUID        NOT NULL REFERENCES credits(id) ON UPDATE CASCADE,

  -- Snapshot ANTES
  original_installments_count INT         NOT NULL,
  original_rate               NUMERIC(8,4) NOT NULL,   -- coeficiente (0.2000 = 20%)
  original_total              NUMERIC(12,2) NOT NULL,  -- capital × (1 + tasa original)
  paid_so_far                 NUMERIC(12,2) NOT NULL,  -- Σ amount_paid al momento del cambio
  pending_before              NUMERIC(12,2) NOT NULL,  -- saldo pendiente previo

  -- Snapshot DESPUÉS
  new_installments_count      INT         NOT NULL,    -- = cuotas pagadas + 1
  new_rate                    NUMERIC(8,4) NOT NULL,   -- coeficiente del plan destino
  new_total                   NUMERIC(12,2) NOT NULL,  -- capital × (1 + tasa nueva)
  new_balance                 NUMERIC(12,2) NOT NULL,  -- saldo recalculado (puede ser <= 0)

  surviving_installment_id    UUID        NULL REFERENCES installments(id) ON UPDATE CASCADE,
  cancelled_installment_ids   JSONB       NULL,        -- ids de cuotas anuladas
  credit_cancelled            BOOLEAN     NOT NULL DEFAULT FALSE, -- true si new_balance <= 0

  -- Auditoría
  reason                      TEXT        NULL,
  executed_by                 UUID        NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
  executed_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_plan_changes_credit
  ON credit_plan_changes(credit_id);

-- ── DOWN (reversión manual) ───────────────────────────────────────────────────
-- DROP TABLE IF EXISTS credit_plan_changes;
-- ALTER TABLE credits DROP CONSTRAINT IF EXISTS credits_settlement_type_check;
-- ALTER TABLE credits ADD CONSTRAINT credits_settlement_type_check
--   CHECK (settlement_type IN ('NORMAL','EARLY_CANCELLATION'));
-- ALTER TABLE installments DROP CONSTRAINT IF EXISTS installments_status_check;
-- ALTER TABLE installments ADD CONSTRAINT installments_status_check
--   CHECK (status IN ('PENDING','PAID','PARTIAL','OVERDUE','REFINANCED'));
