-- ── 032: payments — consistencia del desglose por medio ──────────────────────
-- Garantiza la invariante del pago mixto: el total recibido siempre iguala la
-- suma de sus medios (efectivo + transferencia).
--
-- Para este punto, todos los caminos de inserción ya poblan amount_cash y
-- amount_transfer:
--   · módulo payments (create, createApproved, markInstallmentAsPrepaid, createReversal)
--   · cancelación anticipada (credits.service)
--   · pago anticipado (installments.queries)
--   · seeds y fixtures de integración
-- por lo que el CHECK puede activarse sin romper inserciones existentes.
--
-- Reversible: el constraint puede dropearse sin afectar datos.

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_amount_split_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_amount_split_check
    CHECK (amount_cash + amount_transfer = amount_received);
