// ─────────────────────────────────────────────────────────────────────────────
// Clasificación del CONCEPTO de un movimiento de cobro.
//
// Fuente única compartida por Caja (cashRegister.findMovementsBySessionId),
// Reportes (reports.getCashMovementsReport) y Cobros (payments.findAll) para que
// todas muestren SIEMPRE el mismo concepto y no vuelvan a divergir.
//
// Reutiliza datos ya tipados: payments.is_reversal, payments.generation_type y
// credits.payment_condition. Se expone como función para que cada query pase sus
// propios alias (algunas usan `cr` para credits, otras `c`).
//
// Prioridad (de mayor a menor):
//   1. Reversión de venta de contado   (reversa de un SALE de contado)
//   2. Reversión de cobro              (cualquier otra reversa)
//   3. Venta de contado                (payment_condition = 'CASH')
//   4. Cobro de cuota adelantada       (generation_type = 'ADVANCE_DISTRIBUTION')
//   5. Cobro de cuota                  (cobro normal)
//
// @param {string} p  - alias de la tabla payments en la query (default 'p').
// @param {string} cr - alias de la tabla credits en la query (default 'cr').
// @returns {string} expresión SQL CASE lista para intercalar en un SELECT.
// ─────────────────────────────────────────────────────────────────────────────
const movementConceptCase = (p = "p", cr = "cr") => `
  CASE
    WHEN COALESCE(${p}.is_reversal, FALSE) AND ${cr}.payment_condition = 'CASH'
      THEN 'Reversión de venta de contado'
    WHEN COALESCE(${p}.is_reversal, FALSE)
      THEN 'Reversión de cobro'
    WHEN ${cr}.payment_condition = 'CASH'
      THEN 'Venta de contado'
    WHEN ${p}.generation_type = 'ADVANCE_DISTRIBUTION'
      THEN 'Cobro de cuota adelantada'
    ELSE 'Cobro de cuota'
  END`;

module.exports = { movementConceptCase };
