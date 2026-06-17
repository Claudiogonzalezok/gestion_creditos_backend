-- ── 037: invariante V4.6 — una sola caja por jornada, SIEMPRE ──────────────
--
-- La migración 027 garantizaba "una OPEN por business_day" (índice parcial
-- WHERE status='OPEN'), lo cual permitía a propósito turnos secuenciales
-- (caja A cierra → caja B abre en la misma jornada). El negocio confirmó que
-- esa flexibilidad no se usa y no se quiere: CADA JORNADA TIENE UNA Y SOLO
-- UNA CAJA, sin importar su status (OPEN, PENDING_RECONCILIATION o CLOSED).
--
-- Esta migración reemplaza el índice parcial por uno total: ningún
-- business_day_id puede repetirse en cash_sessions, nunca. El service
-- (cashSessions.service.open, V4.6) ya lo bloquea desde código vía
-- findAnySessionByBusinessDay; esta migración endurece el invariante en DB.
--
-- Pre-requisito de datos: no debe existir más de una caja (de ningún status)
-- por business_day_id. Si la verificación previa encuentra colisión, la
-- migración aborta y requiere acción operativa antes de re-correr.
--
-- Idempotencia: DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS.
-- Re-ejecutar la migración no rompe el estado convergente.

-- ── 1. Verificación previa: cero business_days con >1 caja (cualquier status) ──
DO $$
DECLARE
  v_colisiones INT;
BEGIN
  SELECT COUNT(*) INTO v_colisiones
  FROM (
    SELECT business_day_id
    FROM public.cash_sessions
    GROUP BY business_day_id
    HAVING COUNT(*) > 1
  ) sub;

  IF v_colisiones > 0 THEN
    RAISE EXCEPTION 'Migración 037 abortada: existen % business_days con >1 caja (cualquier status). '
                    'Hay que consolidar o reasignar las cajas duplicadas a jornadas distintas '
                    'antes de re-correr la migración. Query diagnóstica: '
                    'SELECT business_day_id, COUNT(*) FROM cash_sessions '
                    'GROUP BY business_day_id HAVING COUNT(*) > 1;', v_colisiones;
  END IF;
END $$;

-- ── 2. Swap del índice parcial (027) por uno total ──────────────────────────
-- El índice parcial solo protegía contra dos cajas OPEN simultáneas; permitía
-- abrir una segunda caja una vez que la primera estaba CLOSED.
DROP INDEX IF EXISTS public.one_open_session_per_business_day_idx;

-- El índice nuevo es único sobre TODO cash_sessions, sin filtro de status:
-- un business_day_id no puede aparecer dos veces, nunca.
CREATE UNIQUE INDEX IF NOT EXISTS one_session_per_business_day_idx
    ON public.cash_sessions (business_day_id);

-- ── 3. shift_label queda en desuso ──────────────────────────────────────────
-- La columna se agregó en la 027 para etiquetar turnos secuenciales
-- (mañana/tarde/noche). Sin multi-turno no tiene caso de uso nuevo, pero se
-- conserva por compatibilidad de datos históricos — no se borra la columna.
COMMENT ON COLUMN public.cash_sessions.shift_label IS
  'V4.6: en desuso — el modelo multi-turno fue descontinuado (ver migración 037). Se conserva por compat histórica, no usar en flujos nuevos.';
