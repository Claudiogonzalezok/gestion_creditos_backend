-- =============================================================================
-- Migración: trazabilidad tipada del origen de generación de un pago + lote.
--
-- Contexto: las cuotas adelantadas al aprobar una venta dejaban de pasar por
-- `payments` (se registraban como un único `credit_down_payments` de tipo
-- PREPAID_INSTALLMENT, sin fecha de cobro por cuota). Se unifica la trazabilidad
-- en `payments` como única fuente de verdad de la fecha de cobro
-- (`payments.approved_at`). Para distinguir CÓMO se generó cada pago sin recurrir
-- a texto libre en `notes`, se agrega una columna tipada.
--
-- 1. generation_type — describe ÚNICAMENTE el contexto de generación del registro:
--      · COLLECTION           → cobro normal (pre-carga aprobada o cobro directo).
--      · APPROVAL_PREPAYMENT   → cuota adelantada al aprobar la venta.
--      · ADVANCE_DISTRIBUTION  → distribución de un cobro sobre cuotas futuras
--                                (los sub-pagos hijos por excedente).
--
-- 2. batch_id — agrupa lógicamente todos los `payments` generados en una misma
--    operación (ej. una aprobación con N cuotas adelantadas), para trazabilidad,
--    reversión o auditoría futura como unidad. NO se reutiliza parent_payment_id
--    (que representa "cobro padre + su distribución", otra cosa). Queda NULL para
--    el resto de los pagos.
--
-- Compatibilidad histórica: los `credit_down_payments` con PREPAID_INSTALLMENT
-- existentes NO se migran ni se tocan; siguen sumando en caja y apareciendo en
-- los reportes exactamente igual. El nuevo mecanismo aplica solo a las nuevas
-- aprobaciones de venta.
-- =============================================================================

-- 1. generation_type
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS generation_type VARCHAR(30) NOT NULL DEFAULT 'COLLECTION';

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_generation_type_check;

ALTER TABLE payments
  ADD CONSTRAINT payments_generation_type_check
  CHECK (generation_type IN ('COLLECTION', 'APPROVAL_PREPAYMENT', 'ADVANCE_DISTRIBUTION'));

-- Backfill: los sub-pagos por distribución de excedente (hijos) ya existentes
-- pasan a ADVANCE_DISTRIBUTION; el resto queda COLLECTION (default).
UPDATE payments
   SET generation_type = 'ADVANCE_DISTRIBUTION'
 WHERE parent_payment_id IS NOT NULL
   AND generation_type = 'COLLECTION';

-- 2. batch_id (agrupación lógica de la operación que generó los pagos)
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS batch_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_payments_batch_id
  ON payments(batch_id)
  WHERE batch_id IS NOT NULL;
