// ─────────────────────────────────────────────────────────────────────────────
// Clasificación del CONCEPTO de un movimiento de cobro en caja.
//
// Fuente única compartida entre la vista de Caja (cashRegister.queries
// findMovementsBySessionId) y el reporte (reports.queries getCashMovementsReport)
// para que ambos muestren SIEMPRE el mismo concepto y no vuelvan a divergir.
//
// Reutiliza datos ya tipados: payments.is_reversal, payments.generation_type y
// credits.payment_condition. La query que lo use debe exponer los alias `p`
// (payments) y `cr` (credits, vía installments).
//
// Prioridad (de mayor a menor):
//   1. Reversión de venta de contado   (reversa de un SALE de contado)
//   2. Reversión de cobro              (cualquier otra reversa)
//   3. Venta de contado                (payment_condition = 'CASH')
//   4. Cobro de cuota adelantada       (generation_type = 'ADVANCE_DISTRIBUTION')
//   5. Cobro de cuota                  (cobro normal)
// ─────────────────────────────────────────────────────────────────────────────
const MOVEMENT_CONCEPT_CASE = `
  CASE
    WHEN COALESCE(p.is_reversal, FALSE) AND cr.payment_condition = 'CASH'
      THEN 'Reversión de venta de contado'
    WHEN COALESCE(p.is_reversal, FALSE)
      THEN 'Reversión de cobro'
    WHEN cr.payment_condition = 'CASH'
      THEN 'Venta de contado'
    WHEN p.generation_type = 'ADVANCE_DISTRIBUTION'
      THEN 'Cobro de cuota adelantada'
    ELSE 'Cobro de cuota'
  END`;

module.exports = { MOVEMENT_CONCEPT_CASE };
