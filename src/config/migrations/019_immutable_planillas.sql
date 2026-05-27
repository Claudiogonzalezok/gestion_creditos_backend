-- ── 019: Planillas inmutables — snapshot total + ciclo de vida ───────────────
-- Transforma collection_sheets/collection_sheet_details en documentos
-- históricos legales: una vez generadas, NO cambian — ni durante el día.
--
-- Filosofía:
--   · Snapshot = evidencia histórica fija al momento de generación.
--   · Eventos operativos (payments, collection_attempts) viven en sus propias
--     tablas y NUNCA contaminan el snapshot.
--   · Si el cobrador necesita ver "qué pasó hoy con esta cuota", el frontend
--     hace queries separadas — la planilla muestra exclusivamente lo que
--     recibió el cobrador al iniciar la jornada.
--
-- Defensa de la inmutabilidad:
--   · Snapshot completo persistido al insertar el detail.
--   · Trigger BEFORE UPDATE rechaza cualquier cambio sobre columnas snapshot.
--   · El único campo editable es management_status — y solo si la planilla
--     está ACTIVE y su sheet_date = CURRENT_DATE.
--
-- Planillas legacy (pre-019):
--   · Quedan con snapshot_version = 0 y campos snapshot en NULL.
--   · NO se hace backfill (sería falso histórico).
--   · El findById hace fallback a JOINs live SOLO si snapshot_version = 0.

-- ── Snapshot columns en collection_sheet_details ─────────────────────────────
ALTER TABLE collection_sheet_details
  ADD COLUMN IF NOT EXISTS installment_number_snapshot   SMALLINT,
  ADD COLUMN IF NOT EXISTS due_date_snapshot              DATE,
  ADD COLUMN IF NOT EXISTS amount_due_snapshot            NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS amount_paid_snapshot           NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS penalty_amount_snapshot        NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS installment_status_snapshot    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS credit_type_snapshot           VARCHAR(10),
  ADD COLUMN IF NOT EXISTS customer_name_snapshot         VARCHAR(150),
  ADD COLUMN IF NOT EXISTS customer_phone_snapshot        VARCHAR(30),
  ADD COLUMN IF NOT EXISTS customer_address_snapshot      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS next_visit_date_snapshot       DATE,
  ADD COLUMN IF NOT EXISTS has_pending_payment_snapshot   BOOLEAN,
  ADD COLUMN IF NOT EXISTS collection_reference_snapshot  TEXT,
  -- antecedent_id_snapshot referencia el último intento previo al momento de
  -- generación. NULL si no había antecedente. No es FK estricta porque el
  -- antecedente puede provenir de payments o de collection_attempts (los IDs
  -- vienen del CTE de generación).
  ADD COLUMN IF NOT EXISTS antecedent_id_snapshot         UUID;

-- ── Snapshot de identidad + ciclo de vida en collection_sheets ───────────────
ALTER TABLE collection_sheets
  ADD COLUMN IF NOT EXISTS collector_name_snapshot     VARCHAR(150),
  ADD COLUMN IF NOT EXISTS generated_by_name_snapshot  VARCHAR(150),
  ADD COLUMN IF NOT EXISTS closed_at                   TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS closed_by                   UUID NULL
      REFERENCES users(id) ON UPDATE CASCADE,
  ADD COLUMN IF NOT EXISTS snapshot_version            SMALLINT NOT NULL DEFAULT 0;
  -- snapshot_version = 0  → legacy (pre-019, sin snapshot completo)
  -- snapshot_version = 1  → v1 (migration 019, snapshot total)

-- ── Estados extendidos ───────────────────────────────────────────────────────
ALTER TABLE collection_sheets
  DROP CONSTRAINT IF EXISTS collection_sheets_status_check;
ALTER TABLE collection_sheets
  ADD CONSTRAINT collection_sheets_status_check
    CHECK (status IN ('ACTIVE','CLOSED','REGENERATED','CANCELLED'));

-- ── Trigger: inmutabilidad de snapshot en collection_sheet_details ──────────
CREATE OR REPLACE FUNCTION enforce_csd_immutability()
RETURNS TRIGGER AS $$
DECLARE
  sheet_status   TEXT;
  sheet_date_val DATE;
BEGIN
  -- Las columnas snapshot son SIEMPRE inmutables post-insert.
  IF NEW.installment_id                IS DISTINCT FROM OLD.installment_id
  OR NEW.order_number                  IS DISTINCT FROM OLD.order_number
  OR NEW.planned_amount                IS DISTINCT FROM OLD.planned_amount
  OR NEW.inclusion_criteria            IS DISTINCT FROM OLD.inclusion_criteria
  OR NEW.inclusion_reason              IS DISTINCT FROM OLD.inclusion_reason
  OR NEW.op_priority                   IS DISTINCT FROM OLD.op_priority
  OR NEW.remaining_amount_snapshot     IS DISTINCT FROM OLD.remaining_amount_snapshot
  OR NEW.antecedent_type               IS DISTINCT FROM OLD.antecedent_type
  OR NEW.antecedent_date               IS DISTINCT FROM OLD.antecedent_date
  OR NEW.antecedent_notes              IS DISTINCT FROM OLD.antecedent_notes
  OR NEW.installment_number_snapshot   IS DISTINCT FROM OLD.installment_number_snapshot
  OR NEW.due_date_snapshot             IS DISTINCT FROM OLD.due_date_snapshot
  OR NEW.amount_due_snapshot           IS DISTINCT FROM OLD.amount_due_snapshot
  OR NEW.amount_paid_snapshot          IS DISTINCT FROM OLD.amount_paid_snapshot
  OR NEW.penalty_amount_snapshot       IS DISTINCT FROM OLD.penalty_amount_snapshot
  OR NEW.installment_status_snapshot   IS DISTINCT FROM OLD.installment_status_snapshot
  OR NEW.credit_type_snapshot          IS DISTINCT FROM OLD.credit_type_snapshot
  OR NEW.customer_name_snapshot        IS DISTINCT FROM OLD.customer_name_snapshot
  OR NEW.customer_phone_snapshot       IS DISTINCT FROM OLD.customer_phone_snapshot
  OR NEW.customer_address_snapshot     IS DISTINCT FROM OLD.customer_address_snapshot
  OR NEW.next_visit_date_snapshot      IS DISTINCT FROM OLD.next_visit_date_snapshot
  OR NEW.has_pending_payment_snapshot  IS DISTINCT FROM OLD.has_pending_payment_snapshot
  OR NEW.collection_reference_snapshot IS DISTINCT FROM OLD.collection_reference_snapshot
  OR NEW.antecedent_id_snapshot        IS DISTINCT FROM OLD.antecedent_id_snapshot
  THEN
    RAISE EXCEPTION 'Los campos snapshot de una planilla son inmutables (regla de auditoría).';
  END IF;

  -- management_status SOLO editable si la planilla está ACTIVE y es del día actual.
  IF NEW.management_status IS DISTINCT FROM OLD.management_status THEN
    SELECT cs.status, cs.sheet_date INTO sheet_status, sheet_date_val
    FROM collection_sheets cs WHERE cs.id = NEW.sheet_id;

    IF sheet_status IS DISTINCT FROM 'ACTIVE' OR sheet_date_val IS DISTINCT FROM CURRENT_DATE THEN
      RAISE EXCEPTION 'management_status solo es editable mientras la planilla esté ACTIVE y sea del día actual (status=%, sheet_date=%).',
        sheet_status, sheet_date_val;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_csd_immutability ON collection_sheet_details;
CREATE TRIGGER trg_csd_immutability
  BEFORE UPDATE ON collection_sheet_details
  FOR EACH ROW
  EXECUTE FUNCTION enforce_csd_immutability();

-- ── Trigger: inmutabilidad de snapshot + transiciones de estado en collection_sheets
CREATE OR REPLACE FUNCTION enforce_collection_sheet_immutability()
RETURNS TRIGGER AS $$
BEGIN
  -- Campos identitarios y snapshot son inmutables.
  IF NEW.collector_id                 IS DISTINCT FROM OLD.collector_id
  OR NEW.sheet_date                   IS DISTINCT FROM OLD.sheet_date
  OR NEW.filter_used                  IS DISTINCT FROM OLD.filter_used
  OR NEW.generated_by                 IS DISTINCT FROM OLD.generated_by
  OR NEW.collector_name_snapshot      IS DISTINCT FROM OLD.collector_name_snapshot
  OR NEW.generated_by_name_snapshot   IS DISTINCT FROM OLD.generated_by_name_snapshot
  OR NEW.snapshot_version             IS DISTINCT FROM OLD.snapshot_version
  OR NEW.created_at                   IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Los campos identitarios/snapshot de una planilla son inmutables.';
  END IF;

  -- Transiciones de status válidas — solo desde ACTIVE.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'Planilla en estado % no puede cambiar de estado (terminal).', OLD.status;
    END IF;
    IF NEW.status NOT IN ('CLOSED','REGENERATED','CANCELLED') THEN
      RAISE EXCEPTION 'Transición inválida ACTIVE → %.', NEW.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_collection_sheet_immutability ON collection_sheets;
CREATE TRIGGER trg_collection_sheet_immutability
  BEFORE UPDATE ON collection_sheets
  FOR EACH ROW
  EXECUTE FUNCTION enforce_collection_sheet_immutability();

-- ── Documentación inline ─────────────────────────────────────────────────────
COMMENT ON COLUMN collection_sheets.snapshot_version IS
  '0 = legacy (pre-019, sin snapshot completo). 1 = v1 (snapshot total). Reportes deben filtrar por snapshot_version >= 1 para auditoría confiable.';

COMMENT ON COLUMN collection_sheets.closed_at IS
  'Timestamp del cierre del día. NULL mientras la planilla está ACTIVE.';

COMMENT ON COLUMN collection_sheet_details.amount_due_snapshot IS
  'Saldo a cobrar al momento de generación. Inmutable. Si snapshot_version=0 (legacy), está en NULL — fallback a join live.';
