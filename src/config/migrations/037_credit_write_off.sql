-- ── 037: Castigo de crédito (write off) ──────────────────────────────────────
-- Permite retirar un crédito ACTIVE de la operatoria de cobranza (el negocio
-- decide no seguir cobrándolo). Castigo COMPLETO del crédito (V1).
--
-- Patrón espejo de refinanciación: estado terminal en el crédito + cierre de
-- cuotas abiertas + tabla de auditoría. No se borra ni modifica nada histórico
-- (cuotas PAID y pagos quedan intactos).
--
-- Toda la auditoría (motivo/observaciones/usuario/fecha) vive SOLO en
-- credit_write_offs (no se duplica en credits; credits solo cambia de status).
--
-- Reversible: ver DOWN al final.

-- ── 1. Nuevo estado de crédito WRITTEN_OFF ────────────────────────────────────
-- WRITTEN_OFF = castigado (retirado de cobranza), distinto de SETTLED (cobrado).
ALTER TABLE credits DROP CONSTRAINT IF EXISTS credits_status_check;
ALTER TABLE credits ADD CONSTRAINT credits_status_check
  CHECK (status IN ('PENDING_APPROVAL','ACTIVE','SETTLED','REJECTED','EXPIRED','REFINANCED','WRITTEN_OFF'));

-- ── 2. Nuevo estado de cuota WRITTEN_OFF ──────────────────────────────────────
-- Las cuotas abiertas al castigar pasan a WRITTEN_OFF para salir de saldo,
-- planilla y, sobre todo, del cron de mora (que filtra por estado de cuota, no
-- por estado de crédito). La columna ya es VARCHAR(30) (migración 033).
ALTER TABLE installments DROP CONSTRAINT IF EXISTS installments_status_check;
ALTER TABLE installments ADD CONSTRAINT installments_status_check
  CHECK (status IN ('PENDING','PAID','PARTIAL','OVERDUE','REFINANCED','PLAN_CHANGE_CANCELLED','WRITTEN_OFF'));

-- ── 3. Tabla de auditoría credit_write_offs ───────────────────────────────────
-- Único lugar donde vive la trazabilidad del castigo.
CREATE TABLE IF NOT EXISTS credit_write_offs (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_id           UUID          NOT NULL REFERENCES credits(id) ON UPDATE CASCADE,
  written_off_balance NUMERIC(12,2) NOT NULL CHECK (written_off_balance >= 0), -- saldo que se deja de cobrar
  reason              TEXT          NOT NULL,
  observations        TEXT          NULL,
  executed_by         UUID          NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
  executed_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_write_offs_credit
  ON credit_write_offs(credit_id);

-- ── DOWN (reversión manual) ───────────────────────────────────────────────────
-- DROP TABLE IF EXISTS credit_write_offs;
-- ALTER TABLE installments DROP CONSTRAINT IF EXISTS installments_status_check;
-- ALTER TABLE installments ADD CONSTRAINT installments_status_check
--   CHECK (status IN ('PENDING','PAID','PARTIAL','OVERDUE','REFINANCED','PLAN_CHANGE_CANCELLED'));
-- ALTER TABLE credits DROP CONSTRAINT IF EXISTS credits_status_check;
-- ALTER TABLE credits ADD CONSTRAINT credits_status_check
--   CHECK (status IN ('PENDING_APPROVAL','ACTIVE','SETTLED','REJECTED','EXPIRED','REFINANCED'));
