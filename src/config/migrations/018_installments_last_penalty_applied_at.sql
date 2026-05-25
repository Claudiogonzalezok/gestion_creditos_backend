-- Tracking per-cuota del último día en que se procesó mora.
-- Es la fuente de verdad del nuevo motor de catch-up:
--   M (días a aplicar) = effective_today - GREATEST(
--     COALESCE(last_penalty_applied_at, due_date + grace_days) + 1,
--     due_date + grace_days + 1
--   ) + 1
-- y se actualiza SOLO cuando M > 0 (mora realmente aplicada).
--
-- Beneficios sobre depender de cron_execution_log:
--   · Idempotencia per-cuota: re-correr el cron no duplica mora.
--   · Resiliente a corridas parciales y a logs corruptos/borrados.
--   · Soporta retries y, eventualmente, múltiples workers.

ALTER TABLE installments
  ADD COLUMN last_penalty_applied_at DATE NULL;

-- Seed defensivo:
-- IMPORTANTE — este seed asume que el penalty_amount actual representa toda
-- la mora histórica consolidada hasta la fecha. El nuevo engine comienza a
-- calcular incrementalmente desde la próxima corrida.
--
-- No marcamos las cuotas con penalty_amount = 0 — sus last_penalty_applied_at
-- queda NULL y el motor las trata como "primera vez con mora": calcula desde
-- due_date + grace_days. Si una cuota legacy estaba OVERDUE sin penalty
-- aplicada (anomalía del sistema viejo), el motor nuevo aplicará la mora
-- correspondiente — comportamiento aceptable porque preserva la corrección
-- financiera hacia adelante.
UPDATE installments
SET last_penalty_applied_at = CURRENT_DATE - 1
WHERE penalty_amount > 0
  AND status NOT IN ('PAID','REFINANCED');
