-- =============================================================================
-- Migración: anulación de intentos de cobranza (supersede pattern)
-- Permite "anular" un intento como evento auditable, sin DELETE físico.
-- Solo aplica a collection_attempts (NO_PAYMENT / NOT_FOUND).
-- Los pagos parciales mantienen su flujo de reversión existente (is_reversal).
-- =============================================================================

ALTER TABLE collection_attempts
  ADD COLUMN IF NOT EXISTS voided_at  TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS voided_by  UUID REFERENCES users(id);

-- Índice parcial sobre intentos NO anulados, optimiza DISTINCT ON en las CTEs.
CREATE INDEX IF NOT EXISTS idx_collection_attempts_active_inst_created
  ON collection_attempts(installment_id, created_at DESC)
  WHERE voided_at IS NULL;
