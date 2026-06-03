-- ── 027: invariante V4 — una OPEN por business_day (no por owner) ──────────
--
-- Modelo Operativo de Caja V4 (ver docs/cash-model-v4-plan.md y CLAUDE.md):
-- la unicidad de caja operativa pasa de "una OPEN por owner_user_id" a
-- "una OPEN por business_day_id".
--
-- Razón: el cobrador no opera caja (V4 directiva 1.3 y 4.1.3). La caja
-- representa el TURNO operativo de la jornada, no la "caja personal" de
-- un usuario. Pueden existir N cajas en una jornada (turnos secuenciales:
-- mañana 08-12, tarde 16-22, noche 23-04), pero solo UNA OPEN a la vez.
--
-- Pre-requisito de datos: no debe existir más de una caja OPEN simultánea
-- por business_day_id. El service (cashSessions.service.open, V4.4) ya lo
-- bloquea desde código; esta migración endurece el invariante en DB.
-- Si la verificación previa encuentra colisión, la migración aborta y
-- requiere acción operativa antes de re-correr.
--
-- Idempotencia: DROP IF EXISTS + CREATE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS.
-- Re-ejecutar la migración no rompe el estado convergente.

-- ── 1. Verificación previa: cero cajas OPEN paralelas por jornada ──────────
DO $$
DECLARE
  v_colisiones INT;
BEGIN
  SELECT COUNT(*) INTO v_colisiones
  FROM (
    SELECT business_day_id
    FROM public.cash_sessions
    WHERE status = 'OPEN'
    GROUP BY business_day_id
    HAVING COUNT(*) > 1
  ) sub;

  IF v_colisiones > 0 THEN
    RAISE EXCEPTION 'Migración 027 abortada: existen % business_days con >1 caja OPEN simultánea. '
                    'Cerrá o marcá como PENDING_RECONCILIATION todas las cajas OPEN duplicadas '
                    'antes de re-correr la migración. Query diagnóstica: '
                    'SELECT business_day_id, COUNT(*) FROM cash_sessions WHERE status=''OPEN'' '
                    'GROUP BY business_day_id HAVING COUNT(*) > 1;', v_colisiones;
  END IF;
END $$;

-- ── 2. Swap del índice único parcial ────────────────────────────────────────
-- El índice viejo (por owner) deja de ser el invariante de unicidad.
DROP INDEX IF EXISTS public.one_open_session_per_owner_idx;

-- El índice nuevo (por business_day) materializa la regla V4.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_per_business_day_idx
    ON public.cash_sessions (business_day_id)
    WHERE status = 'OPEN';

-- ── 3. Campo opcional shift_label ──────────────────────────────────────────
-- Etiqueta libre del turno (ej. "Mañana", "Tarde", "Noche") para que el
-- frontend o reportes diferencien cajas secuenciales sin depender de horas.
ALTER TABLE public.cash_sessions
    ADD COLUMN IF NOT EXISTS shift_label VARCHAR(40) NULL;

-- ── 4. Semántica nueva de owner_user_id ─────────────────────────────────────
-- El campo se conserva por compat. Su significado cambia: pasa de "dueño
-- contable del dinero" a "cajero responsable del turno".
COMMENT ON COLUMN public.cash_sessions.owner_user_id IS
  'V4: responsable operativo del turno (cajero). NO representa al dueño del dinero ni al cobrador. La caja operativa es de la jornada, no del usuario.';
