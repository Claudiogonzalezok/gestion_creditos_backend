-- Migración: clave de idempotencia para pre-cargas de cobro (P08 / issue #28).
--
-- Contexto: un doble toque o un reintento de red del cobrador podía crear dos
-- pre-cargas PENDING por el mismo dinero. El cliente (app del cobrador) genera
-- un UUID por intento de cobro y lo envía como `client_request_id` en el body
-- de POST /payments. El server garantiza que un mismo cobrador no pueda crear
-- dos pagos con la misma clave.
--
-- Alcance de unicidad: (collector_id, client_request_id). Dos cobradores
-- distintos no colisionan entre sí.
--
-- Cambio aditivo y retrocompatible:
--   · Columna nullable: los pagos existentes y los clientes que no envían la
--     clave quedan con NULL (índice parcial, sin restricción para ellos).
--   · No modifica ni borra datos existentes.
--
-- Reversión (manual, solo si se revierte el código que la usa):
--   DROP INDEX IF EXISTS ux_payments_collector_client_request;
--   ALTER TABLE payments DROP COLUMN IF EXISTS client_request_id;
-- =============================================================================

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS client_request_id UUID NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_collector_client_request
  ON payments (collector_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
