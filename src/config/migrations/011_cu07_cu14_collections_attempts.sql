-- =============================================================================
-- Migración CU07 / CU14 — Cobros parciales, intentos de cobranza y planillas
-- Ejecutar una sola vez contra la base de datos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. payments: fecha de próxima visita (cobros parciales)
-- -----------------------------------------------------------------------------
ALTER TABLE payments ADD COLUMN IF NOT EXISTS next_visit_date DATE;

-- -----------------------------------------------------------------------------
-- 2. collection_attempts: intentos de cobranza sin cobro
--    attempt_type: NO_PAYMENT (cliente presente, no paga)
--                  NOT_FOUND  (cliente no encontrado)
--    collector_id: cobrador responsable de la cartera
--    created_by:   usuario que registró el intento (hoy = collector_id,
--                  en el futuro permite distinguir admin/automatización)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collection_attempts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  installment_id  UUID        NOT NULL REFERENCES installments(id),
  collector_id    UUID        NOT NULL REFERENCES users(id),
  created_by      UUID        NOT NULL REFERENCES users(id),
  attempt_type    VARCHAR(20) NOT NULL
    CHECK (attempt_type IN ('NO_PAYMENT', 'NOT_FOUND')),
  reason          TEXT,
  next_visit_date DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_collection_attempts_installment
  ON collection_attempts(installment_id);

CREATE INDEX IF NOT EXISTS idx_collection_attempts_collector
  ON collection_attempts(collector_id);

-- índice compuesto clave para DISTINCT ON (installment_id) ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_collection_attempts_inst_created
  ON collection_attempts(installment_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 3. collection_sheets: status para soft-delete al regenerar
-- -----------------------------------------------------------------------------
ALTER TABLE collection_sheets
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'REGENERATED'));

CREATE INDEX IF NOT EXISTS idx_collection_sheets_status
  ON collection_sheets(status);

-- -----------------------------------------------------------------------------
-- 4. collection_sheet_details: antecedente, criterio de inclusión y gestión
--    inclusion_criteria: DUE_DATE    (incluida por vencimiento)
--                        VISIT_DATE  (incluida por fecha de próxima visita)
--    antecedent_type:    snapshot del último intento previo a la generación
--    management_status:  preparado para métricas futuras — DEFAULT 'PENDING'
-- -----------------------------------------------------------------------------
ALTER TABLE collection_sheet_details
  ADD COLUMN IF NOT EXISTS inclusion_criteria VARCHAR(20) NOT NULL DEFAULT 'DUE_DATE',
  ADD COLUMN IF NOT EXISTS antecedent_type    VARCHAR(20)
    CHECK (antecedent_type IN ('PARTIAL_PAYMENT', 'NO_PAYMENT', 'NOT_FOUND')),
  ADD COLUMN IF NOT EXISTS antecedent_date    DATE,
  ADD COLUMN IF NOT EXISTS antecedent_notes   TEXT,
  ADD COLUMN IF NOT EXISTS management_status  VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (management_status IN ('PENDING', 'VISITED', 'PAID', 'NO_PAYMENT', 'NOT_FOUND'));
