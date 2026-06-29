-- =============================================================================
-- Migración: Venta de Contado — discriminador de condición de pago en credits.
--
-- Una venta de contado es una venta SALE igual que cualquier otra (mismo flujo
-- de pre-venta del vendedor + aprobación del admin, mismo stock, comisión, caja
-- y reportes). La ÚNICA diferencia es que no se financia: nace SETTLED con una
-- sola cuota pagada al instante, sin tasa de interés.
--
-- `payment_condition` es el marcador mínimo que transporta esa intención a
-- través del límite create→approve (requests distintos). No se agrega ninguna
-- columna de dinero: el split de pago de la contado reutiliza las columnas
-- prepaid_installments_* (lo consume el mecanismo de cuotas prepagas al aprobar).
--
--   FINANCED → comportamiento histórico (default, sin backfill).
--   CASH     → venta de contado.
--
-- Para LOAN la columna es semánticamente inerte (siempre FINANCED).
-- =============================================================================

ALTER TABLE credits
  ADD COLUMN IF NOT EXISTS payment_condition VARCHAR(10) NOT NULL DEFAULT 'FINANCED';

ALTER TABLE credits
  DROP CONSTRAINT IF EXISTS credits_payment_condition_check;

ALTER TABLE credits
  ADD CONSTRAINT credits_payment_condition_check
  CHECK (payment_condition IN ('FINANCED', 'CASH'));
