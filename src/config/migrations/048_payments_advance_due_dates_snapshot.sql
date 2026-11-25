-- =============================================================================
-- Migración: snapshot de vencimientos corridos por un adelanto de cuotas.
--
-- Contexto (issue #41): cuando un cobro adelanta cuotas completas, el sistema
-- corre los vencimientos de las cuotas restantes (shiftInstallmentDates). Al
-- revertir ese cobro no había forma de saber qué fecha tenía cada cuota antes
-- del corrimiento, así que las fechas quedaban corridas para siempre.
--
-- Se guarda, en el cobro cabecera que provocó el corrimiento, un arreglo JSON
-- [{ id, due_date, original_due_date }] con el estado PREVIO de cada cuota
-- corrida. payments.reverse lo usa para restaurar las fechas exactas.
--
-- Cambio aditivo: columna nullable, sin backfill. Los cobros históricos quedan
-- en NULL (su reversión no restaura fechas, igual que antes).
-- =============================================================================

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS advance_due_dates_snapshot JSONB NULL;

COMMENT ON COLUMN payments.advance_due_dates_snapshot IS
  'Vencimientos previos de las cuotas corridas por este cobro (adelanto). Lo usa la reversión.';
