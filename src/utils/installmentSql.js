// ══════════════════════════════════════════════════════════════════════════════
// Snippets SQL reutilizables sobre installments.
// Reflejan la semántica financiera oficial del modelo:
//
//   · original_amount      → capital fijo de la cuota (inmutable).
//   · penalty_amount       → mora acumulada.
//   · amount_due           → deuda viva = original_amount + penalty_amount.
//   · amount_paid          → pagos acumulados (sin distinguir capital vs mora).
//   · saldo_pendiente_real = amount_due − amount_paid (Fórmula B oficial).
//   · is_overdue (derivado) = due_date + grace_days < CURRENT_DATE
//                            AND saldo_pendiente_real > 0
//                            AND status NOT IN ('PAID','REFINANCED','PLAN_CHANGE_CANCELLED').
//
// El campo persistido status='OVERDUE' es un snapshot operativo/visual; la
// lógica financiera no debe depender de él. Estas expresiones permiten usar
// la condición derivada de forma uniforme en jobs, reportes y planillas.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Saldo pendiente real de una cuota (incluye mora acumulada todavía impaga).
 * Equivalente a la Fórmula B del modelo financiero.
 * @param {string} alias - Alias de la tabla installments en la query.
 * @returns {string} Expresión SQL escalar.
 */
const REAL_REMAINING_BALANCE = (alias = 'i') =>
  `(${alias}.amount_due - ${alias}.amount_paid)`;

/**
 * Capital pendiente neto: descuenta primero la mora acumulada del total pagado
 * y devuelve cuánto del capital original sigue sin saldar. No se usa para
 * mora diaria (la Fórmula B usa el saldo pendiente real), pero queda
 * disponible para reportes que necesiten separar capital y mora.
 * @param {string} alias
 * @returns {string} Expresión SQL escalar.
 */
const REMAINING_CAPITAL = (alias = 'i') =>
  `GREATEST(${alias}.original_amount - GREATEST(${alias}.amount_paid - ${alias}.penalty_amount, 0), 0)`;

/**
 * Cuota vencida con saldo, derivada exclusivamente de datos financieros.
 * Defensa en profundidad contra inconsistencias del campo status (cron caído,
 * timezone raro, reversiones a medio aplicar).
 * @param {string} alias - Alias de la tabla installments.
 * @param {string} graceDaysParam - Placeholder Postgres para grace days (ej. '$1').
 * @returns {string} Expresión booleana SQL.
 */
const IS_OVERDUE_DERIVED = (alias = 'i', graceDaysParam = '0') =>
  `(${alias}.due_date < (CURRENT_DATE - (${graceDaysParam})::int * INTERVAL '1 day')
    AND (${alias}.amount_due - ${alias}.amount_paid) > 0
    AND ${alias}.status NOT IN ('PAID','REFINANCED','PLAN_CHANGE_CANCELLED'))`;

module.exports = {
  REAL_REMAINING_BALANCE,
  REMAINING_CAPITAL,
  IS_OVERDUE_DERIVED,
};
