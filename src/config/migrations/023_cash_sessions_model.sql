-- ── 023: Modelo Jornada/Caja/Movimientos (Fase 1) ──────────────────────────────
--
-- Arquitectura de cajas profesional inspirada en POS (Odoo/Square/Shopify) +
-- adaptación para cobranzas:
--
--   branches              : sucursales/canales (preparado para multi-tenant).
--   business_days         : jornada contable diaria por sucursal.
--                            estados: OPEN → READY_TO_CLOSE → CLOSED → AUDITED.
--   cash_sessions         : caja física/lógica abierta por un usuario.
--                            estados: OPEN → CLOSED  |  OPEN → PENDING_RECONCILIATION → CLOSED.
--                            owner_user_id es el RESPONSABLE contable (puede
--                            diferir de opened_by/closed_by/reconciled_by).
--   cash_session_drops    : retiros parciales de efectivo durante la sesión
--                            (depósitos a tesorería). status ACTIVE/REVERSED
--                            (patrón supersede, sin montos negativos).
--   cash_session_closure_details : una fila por método de pago al cerrar,
--                            normaliza la reconciliación filtrable por método.
--
-- En esta migración se crean SOLO las tablas y constraints. La integración con
-- los movimientos (payments, expenses, etc.) se hace en una migración posterior
-- (Fase 2).

-- ── branches ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.branches (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    code        VARCHAR(15)  NOT NULL UNIQUE,
    name        VARCHAR(120) NOT NULL,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Sucursal default. Cuando aparezca multi-sucursal, basta con insertar más
-- filas — el modelo ya está preparado.
INSERT INTO public.branches (code, name)
VALUES ('HQ', 'Casa Central')
ON CONFLICT (code) DO NOTHING;

-- ── business_days ──────────────────────────────────────────────────────────
-- Jornada contable. UNA por (fecha, sucursal). El status no se cierra automá-
-- ticamente cuando todas las cajas terminan: hay un paso intermedio
-- READY_TO_CLOSE para que un supervisor revise y cierre formalmente. AUDITED
-- es opcional para auditoría posterior.
CREATE TABLE IF NOT EXISTS public.business_days (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    business_date       DATE         NOT NULL,
    branch_id           UUID         NOT NULL REFERENCES public.branches(id),
    status              VARCHAR(20)  NOT NULL DEFAULT 'OPEN'
                          CONSTRAINT business_days_status_check
                          CHECK (status IN ('OPEN','READY_TO_CLOSE','CLOSED','AUDITED')),
    opened_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    ready_to_close_at   TIMESTAMPTZ  NULL,
    closed_at           TIMESTAMPTZ  NULL,
    closed_by           UUID         NULL REFERENCES public.users(id),
    audited_at          TIMESTAMPTZ  NULL,
    audited_by          UUID         NULL REFERENCES public.users(id),
    observations        TEXT         NULL,
    CONSTRAINT business_days_date_branch_unique UNIQUE (business_date, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_business_days_status      ON business_days(status);
CREATE INDEX IF NOT EXISTS idx_business_days_branch_date ON business_days(branch_id, business_date DESC);

-- ── cash_sessions ──────────────────────────────────────────────────────────
-- Caja abierta por un usuario. owner_user_id = responsable contable.
-- closure_snapshot guarda la foto inmutable al cerrar (versión 1 documentada
-- en docs); declared_total/diff_status son desnormalizados para listados.
CREATE TABLE IF NOT EXISTS public.cash_sessions (
    id                            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    business_day_id               UUID         NOT NULL REFERENCES public.business_days(id),
    owner_user_id                 UUID         NOT NULL REFERENCES public.users(id),
    opened_at                     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    opened_by                     UUID         NOT NULL REFERENCES public.users(id),
    opening_amount                NUMERIC(12,2) NOT NULL
                                    CONSTRAINT cash_sessions_opening_check CHECK (opening_amount >= 0),
    status                        VARCHAR(25)  NOT NULL DEFAULT 'OPEN'
                                    CONSTRAINT cash_sessions_status_check
                                    CHECK (status IN ('OPEN','PENDING_RECONCILIATION','CLOSED')),
    -- Al cerrar (o al reconciliar tardíamente):
    closed_at                     TIMESTAMPTZ  NULL,
    closed_by                     UUID         NULL REFERENCES public.users(id),
    closure_snapshot              JSONB        NULL,
    closure_total_difference      NUMERIC(12,2) NULL,
    closure_difference_status     VARCHAR(15)  NULL
                                    CONSTRAINT cash_sessions_close_diff_status_check
                                    CHECK (closure_difference_status IS NULL
                                           OR closure_difference_status IN ('EXACT','SURPLUS','SHORTAGE')),
    -- Tránsito por PENDING_RECONCILIATION:
    pending_reconciliation_at     TIMESTAMPTZ  NULL,
    pending_reconciliation_reason TEXT         NULL,
    reconciled_at                 TIMESTAMPTZ  NULL,
    reconciled_by                 UUID         NULL REFERENCES public.users(id),
    observations                  TEXT         NULL,
    -- Integridad de estado: si CLOSED ⇒ debe haber closed_at/closed_by/snapshot.
    CONSTRAINT cash_sessions_closed_integrity CHECK (
        (status <> 'CLOSED')
        OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND closure_snapshot IS NOT NULL)
    ),
    -- Integridad de PENDING: si PENDING ⇒ pending_reconciliation_at/reason completos.
    CONSTRAINT cash_sessions_pending_integrity CHECK (
        (status <> 'PENDING_RECONCILIATION')
        OR (pending_reconciliation_at IS NOT NULL AND pending_reconciliation_reason IS NOT NULL)
    )
);

-- Un cobrador NO puede tener dos cajas OPEN propias simultáneamente. Sí puede
-- tener una OPEN y varias PENDING_RECONCILIATION (pendientes no son activas).
-- Index parcial = patrón PG estándar para "unique mientras condición".
CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_per_owner_idx
    ON cash_sessions (owner_user_id)
    WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_cash_sessions_business_day ON cash_sessions(business_day_id);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_owner_status ON cash_sessions(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_status      ON cash_sessions(status);

-- ── cash_session_drops ─────────────────────────────────────────────────────
-- Retiros parciales (cash drops) durante la sesión. Sin montos negativos:
-- compensación = mismo registro con status='REVERSED' + auditoría de quien revierte.
CREATE TABLE IF NOT EXISTS public.cash_session_drops (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_session_id    UUID         NOT NULL REFERENCES public.cash_sessions(id),
    amount             NUMERIC(12,2) NOT NULL
                         CONSTRAINT cash_session_drops_amount_check CHECK (amount > 0),
    payment_method     VARCHAR(15)  NOT NULL
                         CONSTRAINT cash_session_drops_method_check
                         CHECK (payment_method IN ('CASH','TRANSFER')),
    destination        VARCHAR(120) NOT NULL,
    reason             TEXT         NULL,
    receipt_reference  VARCHAR(120) NULL,
    status             VARCHAR(15)  NOT NULL DEFAULT 'ACTIVE'
                         CONSTRAINT cash_session_drops_status_check
                         CHECK (status IN ('ACTIVE','REVERSED')),
    performed_by       UUID         NOT NULL REFERENCES public.users(id),
    performed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    reversed_at        TIMESTAMPTZ  NULL,
    reversed_by        UUID         NULL REFERENCES public.users(id),
    reversed_reason    TEXT         NULL,
    -- Integridad: ACTIVE no debe tener campos de reversión; REVERSED debe tenerlos.
    CONSTRAINT cash_session_drops_reversal_integrity CHECK (
        (status = 'ACTIVE'   AND reversed_at IS NULL     AND reversed_by IS NULL)
        OR
        (status = 'REVERSED' AND reversed_at IS NOT NULL AND reversed_by IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_cash_session_drops_session ON cash_session_drops(cash_session_id);
CREATE INDEX IF NOT EXISTS idx_cash_session_drops_status  ON cash_session_drops(cash_session_id, status);

-- ── cash_session_closure_details ───────────────────────────────────────────
-- Una fila por método declarado al cerrar la caja. Normaliza la información
-- de reconciliación para queries por método (ej.: "todas las diferencias en
-- transferencia del último mes").
CREATE TABLE IF NOT EXISTS public.cash_session_closure_details (
    id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_session_id     UUID          NOT NULL REFERENCES public.cash_sessions(id),
    payment_method      VARCHAR(15)   NOT NULL
                          CONSTRAINT cash_session_closure_details_method_check
                          CHECK (payment_method IN ('CASH','TRANSFER','MP','QR','CHECK','OTHER')),
    expected_amount     NUMERIC(12,2) NOT NULL,
    declared_amount     NUMERIC(12,2) NOT NULL,
    difference          NUMERIC(12,2) NOT NULL,
    difference_status   VARCHAR(15)   NOT NULL
                          CONSTRAINT cash_session_closure_details_diff_status_check
                          CHECK (difference_status IN ('EXACT','SURPLUS','SHORTAGE')),
    notes               TEXT          NULL,
    CONSTRAINT cash_session_closure_details_unique_per_method
        UNIQUE (cash_session_id, payment_method)
);

CREATE INDEX IF NOT EXISTS idx_cash_session_closure_details_session
    ON cash_session_closure_details(cash_session_id);
