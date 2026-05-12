-- ── 006: Extensión de payments para cobranzas avanzadas ──────────────────────
-- Agrega soporte para:
--   · Pago directo admin (create + approve atómico)
--   · Reversión total por compensating transaction (nunca DELETE)
--
-- IMPORTANTE: No modifica columnas existentes ni constraints críticos.
-- Todas las columnas nuevas son NULL o con DEFAULT seguro.
-- Reversible: las columnas pueden dropearse sin afectar datos previos.

-- ── Columnas de reversión ─────────────────────────────────────────────────────
-- Un payment revertido genera un nuevo payment con is_reversal=TRUE que apunta
-- al original. Nunca se borra ni modifica el registro original.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS is_reversal              BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reversal_reason          TEXT        NULL,
  ADD COLUMN IF NOT EXISTS reversed_by_payment_id  UUID        NULL
      REFERENCES payments(id) ON UPDATE CASCADE;

-- ── Columna de pago directo admin ─────────────────────────────────────────────
-- Distingue pagos registrados por el flujo normal (collector → aprobación)
-- de los registrados y aprobados en un único paso por un administrador.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS admin_direct  BOOLEAN  NOT NULL DEFAULT FALSE;

-- ── Constraint: un payment revertido solo puede tener reversed_by una vez ─────
-- Garantiza que no existan dos reversiones apuntando al mismo payment original.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_reversed_by
  ON payments(reversed_by_payment_id)
  WHERE reversed_by_payment_id IS NOT NULL;

-- ── Constraint: reversión no puede apuntar a sí misma ─────────────────────────
ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_no_self_reversal;
ALTER TABLE payments
  ADD CONSTRAINT payments_no_self_reversal
    CHECK (reversed_by_payment_id IS NULL OR reversed_by_payment_id <> id);

-- ── Índice para consultas de reversión ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_payments_is_reversal
  ON payments(is_reversal)
  WHERE is_reversal = TRUE;
