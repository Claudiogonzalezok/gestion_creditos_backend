-- =============================================================================
-- Migración: agregar 'RENEWAL' a los tipos de generación de un pago.
--
-- Contexto: renovación de préstamos LOAN de una sola cuota. El cliente paga solo
-- el interés del período para extender el vencimiento; el capital no cambia. Ese
-- pago se registra como cualquier otro cobro (mismo impacto en caja), pero se
-- distingue con generation_type = 'RENEWAL' para:
--   · mostrar el concepto "Renovación" en Caja/Reportes (movementConcept);
--   · excluirlo de la derivación "cobrado el/por" de la cuota en credits.findById
--     (la cuota sigue debiéndose, no está pagada).
--
-- Cambio mínimo y aditivo: solo se amplía el CHECK existente, sin columnas ni
-- tablas nuevas. Retrocompatible con todos los pagos actuales.
-- =============================================================================

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_generation_type_check;

ALTER TABLE payments
  ADD CONSTRAINT payments_generation_type_check
  CHECK (generation_type IN ('COLLECTION', 'APPROVAL_PREPAYMENT', 'ADVANCE_DISTRIBUTION', 'RENEWAL'));
