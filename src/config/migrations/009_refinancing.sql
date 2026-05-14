-- ── 009: Refinanciación de créditos ──────────────────────────────────────────
-- Permite refinanciar un crédito ACTIVE creando un nuevo crédito LOAN que
-- absorbe el saldo pendiente. El crédito original pasa a estado REFINANCED
-- (deuda trasladada, distinto de SETTLED que implica deuda cancelada).
--
-- Estrategia: Opción A — nuevo crédito vinculado al original.
-- Reutiliza completamente el flujo create() → approve() existente.
-- No modifica cuotas ni pagos históricos.
--
-- Reversible: ver sección DOWN al final del archivo.

-- ── 1. Nuevo estado REFINANCED en credits ─────────────────────────────────────
-- Reemplaza el CHECK existente agregando el estado 'REFINANCED'.
-- REFINANCED = deuda trasladada (≠ SETTLED = deuda cancelada).

ALTER TABLE credits
  DROP CONSTRAINT IF EXISTS credits_status_check;

ALTER TABLE credits
  ADD CONSTRAINT credits_status_check
  CHECK (status IN (
    'PENDING_APPROVAL',
    'ACTIVE',
    'SETTLED',
    'REJECTED',
    'EXPIRED',
    'REFINANCED'
  ));

-- ── 2. Columnas de trazabilidad en credits ────────────────────────────────────
-- refinanced_from_credit_id: apunta al crédito original que fue refinanciado.
--   NULL en créditos normales; NOT NULL en créditos de refinanciación.
--   Permite reconstruir cadena A → B → C con CTE recursiva.
--
-- refinanced_at / refinanced_by / refinanced_reason: snapshot en el crédito
--   original para auditoría rápida sin necesidad de JOIN a credit_refinancings.

ALTER TABLE credits
  ADD COLUMN IF NOT EXISTS refinanced_from_credit_id UUID NULL
    REFERENCES credits(id) ON UPDATE CASCADE,
  ADD COLUMN IF NOT EXISTS refinanced_at             TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS refinanced_by             UUID NULL
    REFERENCES users(id) ON UPDATE CASCADE,
  ADD COLUMN IF NOT EXISTS refinanced_reason         TEXT NULL;

-- ── 3. Índices sobre credits ──────────────────────────────────────────────────
-- Cubre búsquedas: "¿cuál es el sucesor de este crédito?" y timelines.
CREATE INDEX IF NOT EXISTS idx_credits_refinanced_from
  ON credits(refinanced_from_credit_id)
  WHERE refinanced_from_credit_id IS NOT NULL;

-- Cubre dashboards y reportes que filtran por status = 'REFINANCED'.
-- El índice idx_credits_status ya existe; este es un índice parcial específico
-- para consultas frecuentes que solo necesitan créditos refinanciados.
CREATE INDEX IF NOT EXISTS idx_credits_status_refinanced
  ON credits(status)
  WHERE status = 'REFINANCED';

-- ── 4. Tabla de trazabilidad credit_refinancings ──────────────────────────────
-- Registro inmutable por cada operación de refinanciación ejecutada.
-- Captura el estado financiero exacto en el momento de la operación:
-- saldo trasladado, cargos adicionales, total, tipo, motivo y auditoría.
--
-- refinancing_type arranca con 'STANDARD'. Preparado para:
--   PARTIAL   — refinanciación de cuotas seleccionadas
--   CAMPAIGN  — condiciones especiales de campaña
--   JUDICIAL  — créditos en proceso judicial
--   AUTOMATIC — refinanciación por regla automática
--
-- metadata JSONB: reservado para datos específicos por tipo (ej: installment_ids
--   en refinanciación parcial, campaign_id en campañas, etc.).

CREATE TABLE IF NOT EXISTS credit_refinancings (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  original_credit_id  UUID        NOT NULL REFERENCES credits(id) ON UPDATE CASCADE,
  new_credit_id       UUID        NOT NULL REFERENCES credits(id) ON UPDATE CASCADE,

  -- Componentes financieros del saldo trasladado
  pending_balance     NUMERIC(12,2) NOT NULL CHECK (pending_balance > 0),
  extra_charges       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (extra_charges >= 0),
  total_transferred   NUMERIC(12,2) NOT NULL CHECK (total_transferred > 0),
  -- total_transferred = pending_balance + extra_charges (validado en aplicación)

  -- Clasificación y metadatos
  refinancing_type    VARCHAR(30) NOT NULL DEFAULT 'STANDARD'
    CHECK (refinancing_type IN ('STANDARD', 'PARTIAL', 'CAMPAIGN', 'JUDICIAL', 'AUTOMATIC')),
  reason              TEXT        NOT NULL,
  notes               TEXT        NULL,
  metadata            JSONB       NULL,

  -- Auditoría
  executed_by         UUID        NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
  executed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Integridad: no puede refinanciarse a sí mismo
  CONSTRAINT chk_refinancing_no_self_reference
    CHECK (original_credit_id <> new_credit_id)
);

-- ── 5. Índices sobre credit_refinancings ──────────────────────────────────────
-- "¿Cuántas veces fue refinanciado este crédito?" / timeline hacia adelante
CREATE INDEX IF NOT EXISTS idx_credit_refinancings_original
  ON credit_refinancings(original_credit_id);

-- "¿Este crédito es una refinanciación de alguno?" / timeline hacia atrás
CREATE INDEX IF NOT EXISTS idx_credit_refinancings_new
  ON credit_refinancings(new_credit_id);

-- ── DOWN (reversión manual) ───────────────────────────────────────────────────
-- Para revertir esta migración ejecutar en orden:
--
-- DROP TABLE IF EXISTS credit_refinancings;
--
-- ALTER TABLE credits
--   DROP COLUMN IF EXISTS refinanced_from_credit_id,
--   DROP COLUMN IF EXISTS refinanced_at,
--   DROP COLUMN IF EXISTS refinanced_by,
--   DROP COLUMN IF EXISTS refinanced_reason;
--
-- ALTER TABLE credits DROP CONSTRAINT IF EXISTS credits_status_check;
-- ALTER TABLE credits ADD CONSTRAINT credits_status_check
--   CHECK (status IN ('PENDING_APPROVAL','ACTIVE','SETTLED','REJECTED','EXPIRED'));
--
-- DROP INDEX IF EXISTS idx_credits_refinanced_from;
-- DROP INDEX IF EXISTS idx_credits_status_refinanced;
