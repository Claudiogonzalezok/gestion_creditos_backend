-- ── 031: cash_movements — permitir desglose por medio en un mismo cobro ──────
-- Habilita el pago mixto a nivel de la caché legacy cash_movements.
--
-- Un cobro mixto genera DOS movimientos del mismo tipo para el mismo payment:
-- uno CASH y uno TRANSFER. El índice único anterior (payment_id, movement_type)
-- lo impedía. Se reemplaza por (payment_id, movement_type, payment_method), que
-- sigue garantizando que no haya movimientos duplicados del mismo tipo y medio,
-- pero admite el split efectivo + transferencia.
--
-- NOTA: cash_movements es @deprecated (la verdad V4 vive en cash_sessions). Este
-- ajuste es solo de compatibilidad para que la caché y el dashboard antiguo no
-- rechacen un cobro mixto; no agrega lógica de negocio nueva sobre la tabla.
--
-- Reversible: se puede restaurar el índice anterior si no existen cobros mixtos.

DROP INDEX IF EXISTS idx_cash_movements_payment_type;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_movements_payment_type_method
  ON cash_movements(payment_id, movement_type, payment_method);
