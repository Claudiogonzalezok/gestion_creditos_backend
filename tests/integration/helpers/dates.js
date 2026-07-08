// Helpers de fechas para tests de integration.
//
// NOTA arquitectónica: PostgreSQL evalúa CURRENT_DATE contra el reloj real
// del servidor — no se puede "freezear" desde JS sin reescribir queries.
// La estrategia oficial del proyecto es:
//
//   · Computar las due_date de las fixtures RELATIVAS a hoy.
//   · Ejecutar el código real (cron, queries) con CURRENT_DATE de verdad.
//   · Aserciones sobre los efectos observables (status, penalty, etc.).
//
// Ej: para testear "una cuota vencida hace 10 días", se crea la cuota con
// due_date = daysAgo(10) y se corre el job. El job ve la diferencia real.

/**
 * Devuelve una fecha en formato 'YYYY-MM-DD' (PostgreSQL date).
 * @param {Date} d
 * @returns {string}
 */
const isoDate = (d) => {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

/**
 * Fecha de hoy en 'YYYY-MM-DD'.
 * @returns {string}
 */
const today = () => isoDate(new Date());

/**
 * Devuelve la fecha N días en el pasado, formato 'YYYY-MM-DD'.
 * @param {number} n
 * @returns {string}
 */
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
};

/**
 * Devuelve la fecha N días en el futuro, formato 'YYYY-MM-DD'.
 * @param {number} n
 * @returns {string}
 */
const daysFromNow = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoDate(d);
};

module.exports = { isoDate, today, daysAgo, daysFromNow };
