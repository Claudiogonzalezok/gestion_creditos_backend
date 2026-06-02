-- ── 024: cash_session_id en movimientos + backfill histórico (Fase 2) ───────
--
-- Agrega la columna nullable cash_session_id a las tablas de movimientos para
-- vincular cada movimiento a la caja en la que fue registrado. La columna nace
-- NULL para no romper datos viejos; el código de la app exige caja OPEN del
-- usuario para crear movimientos nuevos.
--
-- Backfill: por cada cierre histórico en cash_registers crea una jornada
-- AUDITED + una caja sintética CLOSED con snapshot mínimo, y vincula los
-- movimientos del día (payments aprobados, down_payments, expenses,
-- cash_conversions, commission_liquidations) a esa caja sintética.
--
-- Idempotencia: si la migración se vuelve a aplicar (re-correr el setup), no
-- duplica ni jornadas ni cajas — usa ON CONFLICT y un guard por
-- closure_snapshot->>'migrated_from_cash_register_id'.

-- ── 1. Columnas FK en tablas de movimientos ────────────────────────────────
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS cash_session_id UUID NULL
    REFERENCES public.cash_sessions(id) ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS idx_payments_cash_session
  ON payments(cash_session_id) WHERE cash_session_id IS NOT NULL;

ALTER TABLE public.credit_down_payments
  ADD COLUMN IF NOT EXISTS cash_session_id UUID NULL
    REFERENCES public.cash_sessions(id) ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS idx_credit_down_payments_cash_session
  ON credit_down_payments(cash_session_id) WHERE cash_session_id IS NOT NULL;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS cash_session_id UUID NULL
    REFERENCES public.cash_sessions(id) ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS idx_expenses_cash_session
  ON expenses(cash_session_id) WHERE cash_session_id IS NOT NULL;

ALTER TABLE public.cash_conversions
  ADD COLUMN IF NOT EXISTS cash_session_id UUID NULL
    REFERENCES public.cash_sessions(id) ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS idx_cash_conversions_cash_session
  ON cash_conversions(cash_session_id) WHERE cash_session_id IS NOT NULL;

ALTER TABLE public.commission_liquidations
  ADD COLUMN IF NOT EXISTS cash_session_id UUID NULL
    REFERENCES public.cash_sessions(id) ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS idx_commission_liquidations_cash_session
  ON commission_liquidations(cash_session_id) WHERE cash_session_id IS NOT NULL;

-- ── 2. Backfill histórico ──────────────────────────────────────────────────
DO $$
DECLARE
  v_branch_id        UUID;
  v_register         RECORD;
  v_business_day_id  UUID;
  v_existing_session UUID;
  v_session_id       UUID;
  v_snapshot         JSONB;
BEGIN
  -- Sucursal default ('HQ' insertada en migración 023).
  SELECT id INTO v_branch_id FROM public.branches WHERE code = 'HQ' LIMIT 1;
  IF v_branch_id IS NULL THEN
    RAISE EXCEPTION 'Backfill: no se encontró sucursal HQ (migración 023 no aplicada?).';
  END IF;

  FOR v_register IN
    SELECT id, register_date, total_collected, cash_amount, transfer_amount,
           total_outflows, declared_cash, difference, difference_status,
           observations, closed_by, created_at
    FROM public.cash_registers
    ORDER BY register_date
  LOOP
    -- Jornada del día (idempotente vía UNIQUE).
    INSERT INTO public.business_days
      (business_date, branch_id, status, opened_at, ready_to_close_at,
       closed_at, closed_by, audited_at, audited_by, observations)
    VALUES
      (v_register.register_date, v_branch_id, 'AUDITED',
       v_register.created_at, v_register.created_at,
       v_register.created_at, v_register.closed_by,
       v_register.created_at, v_register.closed_by,
       COALESCE(v_register.observations, '') || ' [migrado de cash_registers]')
    ON CONFLICT (business_date, branch_id) DO NOTHING
    RETURNING id INTO v_business_day_id;

    IF v_business_day_id IS NULL THEN
      SELECT id INTO v_business_day_id
        FROM public.business_days
       WHERE business_date = v_register.register_date
         AND branch_id     = v_branch_id;
    END IF;

    -- Guard idempotencia: si ya existe sesión sintética vinculada a este
    -- cash_register histórico, skip todo el ciclo.
    SELECT id INTO v_existing_session
      FROM public.cash_sessions
     WHERE business_day_id = v_business_day_id
       AND closure_snapshot ->> 'migrated_from_cash_register_id' = v_register.id::text
     LIMIT 1;

    IF v_existing_session IS NOT NULL THEN
      CONTINUE;
    END IF;

    -- Snapshot mínimo que respeta el formato v1. Los desgloses por método
    -- quedan en 0 porque cash_registers no los persistía a ese nivel; el
    -- expected/declared/difference sí provienen del cierre histórico.
    v_snapshot := jsonb_build_object(
      'version',     1,
      'captured_at', to_char(v_register.created_at AT TIME ZONE current_setting('TimeZone'),
                              'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'captured_by', v_register.closed_by,
      'opening',     jsonb_build_object('cash', 0, 'transfer', 0),
      'collections', jsonb_build_object(
        'payments',      jsonb_build_object('cash', 0, 'transfer', 0),
        'down_payments', jsonb_build_object('cash', 0, 'transfer', 0)
      ),
      'outflows',    jsonb_build_object(
        'expenses',    jsonb_build_object('cash', 0, 'transfer', 0),
        'commissions', jsonb_build_object('cash', 0, 'transfer', 0)
      ),
      'conversions', jsonb_build_object('cash_delta', 0, 'transfer_delta', 0),
      'drops',       jsonb_build_object('cash', 0, 'transfer', 0, 'items', '[]'::jsonb),
      'expected',    jsonb_build_object('cash', v_register.cash_amount,
                                        'transfer', v_register.transfer_amount),
      'declared',    jsonb_build_object('cash', v_register.declared_cash,
                                        'transfer', 0),
      'difference',  jsonb_build_object('cash', v_register.difference,
                                        'transfer', 0),
      'migrated_from_cash_register_id', v_register.id::text
    );

    INSERT INTO public.cash_sessions
      (business_day_id, owner_user_id, opened_at, opened_by, opening_amount,
       status, closed_at, closed_by,
       closure_snapshot, closure_total_difference, closure_difference_status,
       observations)
    VALUES
      (v_business_day_id, v_register.closed_by, v_register.created_at,
       v_register.closed_by, 0,
       'CLOSED', v_register.created_at, v_register.closed_by,
       v_snapshot, v_register.difference, v_register.difference_status,
       'Sesión sintética migrada del cierre #' || v_register.id::text)
    RETURNING id INTO v_session_id;

    -- Vinculación de movimientos del día a la caja sintética. NULL-safe (los
    -- ya vinculados no se tocan, así que correr la migración varias veces no
    -- sobrescribe nada).
    UPDATE public.payments
       SET cash_session_id = v_session_id
     WHERE cash_session_id IS NULL
       AND status = 'APPROVED'
       AND approved_at::date = v_register.register_date;

    UPDATE public.credit_down_payments
       SET cash_session_id = v_session_id
     WHERE cash_session_id IS NULL
       AND register_date = v_register.register_date
       AND payment_type = 'DOWN_PAYMENT';

    UPDATE public.expenses
       SET cash_session_id = v_session_id
     WHERE cash_session_id IS NULL
       AND register_date = v_register.register_date;

    UPDATE public.cash_conversions
       SET cash_session_id = v_session_id
     WHERE cash_session_id IS NULL
       AND register_date = v_register.register_date;

    UPDATE public.commission_liquidations
       SET cash_session_id = v_session_id
     WHERE cash_session_id IS NULL
       AND cash_register_id = v_register.id;
  END LOOP;
END $$;
