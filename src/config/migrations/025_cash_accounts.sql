-- ── 025: Caja General + movimientos consolidados (Fase 3) ──────────────────
--
-- Introduce el concepto de "Caja General" como cuenta consolidada del negocio
-- (separada de las cajas operativas de cobradores). Diseñada como base de una
-- futura Tesorería multi-cuenta sin sobre-ingeniería en esta fase.
--
--   cash_accounts            : cuentas financieras del negocio. Hoy solo soporta
--                              type='GENERAL_CASH' (única). El esquema queda
--                              preparado para sumar BANK/EWALLET en el futuro.
--   cash_account_movements   : libro de movimientos. Fuente de verdad contable.
--                              No permite UPDATE/DELETE: correcciones vía
--                              movimientos ADJUSTMENT compensatorios.
--   current_balance          : campo CACHEADO en cash_accounts. Calculado desde
--                              los movimientos en esta migración y mantenido
--                              transaccionalmente por la app. Auditable vía
--                              SUM(IN) - SUM(OUT) en cualquier momento.
--
-- Integración con drops: cash_session_drops gana destination_account_id (FK a
-- cash_accounts). La columna destination histórica se DEPRECA (queda nullable,
-- con COMMENT) — la eliminación física se hará en una fase posterior de cleanup.
--
-- Backfill: por cada drop ACTIVE preexistente se genera un movimiento DROP_IN
-- en la Caja General y se inicializa current_balance desde la suma real de
-- movimientos. Idempotente vía índice único parcial sobre (reference_type,
-- reference_id) para DROP_IN.

-- ── 1. cash_accounts ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cash_accounts (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(120)  NOT NULL,
    type            VARCHAR(20)   NOT NULL
                      CONSTRAINT cash_accounts_type_check
                      CHECK (type IN ('GENERAL_CASH')),
    is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
    current_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Seed obligatorio. Idempotente sin depender de UNIQUE(type) para no cerrar la
-- puerta a múltiples cuentas del mismo tipo en el futuro.
INSERT INTO public.cash_accounts (name, type)
SELECT 'Caja General', 'GENERAL_CASH'
WHERE NOT EXISTS (
    SELECT 1 FROM public.cash_accounts WHERE type = 'GENERAL_CASH'
);

CREATE INDEX IF NOT EXISTS idx_cash_accounts_type_active
    ON public.cash_accounts(type) WHERE is_active = TRUE;

-- ── 2. cash_account_movements ──────────────────────────────────────────────
-- Libro contable append-only. direction es explícito (IN/OUT) — no se deriva
-- del movement_type — para soportar ADJUSTMENT bidireccional y futuras
-- transferencias entre cuentas.
CREATE TABLE IF NOT EXISTS public.cash_account_movements (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_account_id   UUID          NOT NULL REFERENCES public.cash_accounts(id),
    movement_type     VARCHAR(25)   NOT NULL
                        CONSTRAINT cash_account_movements_type_check
                        CHECK (movement_type IN (
                            'DROP_IN','SUPPLIER_PAYMENT','SALARY_PAYMENT',
                            'EXPENSE','ADJUSTMENT'
                        )),
    direction         VARCHAR(3)    NOT NULL
                        CONSTRAINT cash_account_movements_direction_check
                        CHECK (direction IN ('IN','OUT')),
    amount            NUMERIC(12,2) NOT NULL
                        CONSTRAINT cash_account_movements_amount_check CHECK (amount > 0),
    description       TEXT          NULL,
    beneficiary_name  VARCHAR(200)  NULL,
    -- Trazabilidad polimórfica: vínculo opcional a la entidad que originó el
    -- movimiento (drop, liquidación, otro movimiento compensado, etc.).
    reference_type    VARCHAR(40)   NULL,
    reference_id      UUID          NULL,
    created_by        UUID          NOT NULL REFERENCES public.users(id),
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    -- Coherencia movement_type ↔ direction: solo ADJUSTMENT puede ser IN u OUT,
    -- el resto tienen dirección fija.
    CONSTRAINT cash_account_movements_type_direction_check CHECK (
        (movement_type = 'DROP_IN'          AND direction = 'IN')  OR
        (movement_type = 'SUPPLIER_PAYMENT' AND direction = 'OUT') OR
        (movement_type = 'SALARY_PAYMENT'   AND direction = 'OUT') OR
        (movement_type = 'EXPENSE'          AND direction = 'OUT') OR
        (movement_type = 'ADJUSTMENT'       AND direction IN ('IN','OUT'))
    ),
    -- reference_type y reference_id van juntos o ambos NULL.
    CONSTRAINT cash_account_movements_reference_pair_check CHECK (
        (reference_type IS NULL     AND reference_id IS NULL) OR
        (reference_type IS NOT NULL AND reference_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_cam_account_created
    ON cash_account_movements(cash_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cam_reference
    ON cash_account_movements(reference_type, reference_id)
    WHERE reference_type IS NOT NULL;

-- Idempotencia del backfill: como máximo un DROP_IN por drop, y un
-- ADJUSTMENT compensatorio por movimiento de origen.
CREATE UNIQUE INDEX IF NOT EXISTS cam_one_drop_in_per_drop_idx
    ON cash_account_movements(reference_id)
    WHERE movement_type = 'DROP_IN' AND reference_type = 'CASH_SESSION_DROP';

CREATE UNIQUE INDEX IF NOT EXISTS cam_one_adjustment_per_origin_idx
    ON cash_account_movements(reference_id)
    WHERE movement_type = 'ADJUSTMENT' AND reference_type = 'CASH_ACCOUNT_MOVEMENT';

-- ── 3. cash_session_drops.destination_account_id ───────────────────────────
ALTER TABLE public.cash_session_drops
    ADD COLUMN IF NOT EXISTS destination_account_id UUID
        REFERENCES public.cash_accounts(id);

-- Backfill: todos los drops históricos apuntan a la Caja General.
UPDATE public.cash_session_drops
   SET destination_account_id = (
         SELECT id FROM public.cash_accounts WHERE type = 'GENERAL_CASH' LIMIT 1
       )
 WHERE destination_account_id IS NULL;

ALTER TABLE public.cash_session_drops
    ALTER COLUMN destination_account_id SET NOT NULL;

-- destination queda DEPRECADO: se mantiene la columna para compatibilidad y
-- se relaja el NOT NULL para no obligar a la app a seguir escribiéndolo.
ALTER TABLE public.cash_session_drops
    ALTER COLUMN destination DROP NOT NULL;

COMMENT ON COLUMN public.cash_session_drops.destination IS
    'DEPRECATED: usar destination_account_id (FK a cash_accounts). Se eliminará en una fase posterior de cleanup.';

CREATE INDEX IF NOT EXISTS idx_cash_session_drops_destination_account
    ON cash_session_drops(destination_account_id);

-- ── 4. Backfill DROP_IN histórico ──────────────────────────────────────────
-- Por cada drop ACTIVE preexistente, registramos el movimiento equivalente en
-- la cuenta destino. Idempotente vía cam_one_drop_in_per_drop_idx.
INSERT INTO public.cash_account_movements
    (cash_account_id, movement_type, direction, amount, description,
     reference_type, reference_id, created_by, created_at)
SELECT
    d.destination_account_id,
    'DROP_IN',
    'IN',
    d.amount,
    'Backfill drop histórico (migración 025)',
    'CASH_SESSION_DROP',
    d.id,
    d.performed_by,
    d.performed_at
  FROM public.cash_session_drops d
 WHERE d.status = 'ACTIVE'
ON CONFLICT DO NOTHING;

-- ── 5. Inicialización de current_balance ───────────────────────────────────
-- Se calcula desde los movimientos ya insertados (NO se hardcodea ni se lee
-- desde drops.amount). Esto preserva la invariante:
--     current_balance == SUM(IN) - SUM(OUT)
-- y deja la migración convergente al mismo valor si se re-ejecuta.
UPDATE public.cash_accounts ca
   SET current_balance = COALESCE((
         SELECT SUM(CASE WHEN m.direction = 'IN' THEN m.amount ELSE -m.amount END)
           FROM public.cash_account_movements m
          WHERE m.cash_account_id = ca.id
       ), 0);
