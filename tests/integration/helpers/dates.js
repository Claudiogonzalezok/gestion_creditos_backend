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
 * Zona horaria de la sesión de PostgreSQL: misma regla que src/config/db.js
 * (`-c TimeZone=${process.env.TZ || 'America/Argentina/Buenos_Aires'}`).
 * Calcular las fechas en esta zona hace que coincidan con CURRENT_DATE aunque
 * el proceso Node corra en otra zona (por ejemplo, un runner de CI en UTC).
 * @returns {string}
 */
const dbTimeZone = () => process.env.TZ || 'America/Argentina/Buenos_Aires';

/**
 * Devuelve la fecha calendario de `d` en la zona de la BD, formato 'YYYY-MM-DD'.
 * @param {Date} d
 * @returns {string}
 */
const isoDate = (d) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: dbTimeZone(),
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
  }).format(d);

/**
 * Suma N días a una fecha 'YYYY-MM-DD' con aritmética UTC (sin efectos de DST).
 * @param {string} ymd
 * @param {number} n
 * @returns {string}
 */
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Fecha de hoy en 'YYYY-MM-DD', según la zona de la BD.
 * @returns {string}
 */
const today = () => isoDate(new Date());

/**
 * Devuelve la fecha N días en el pasado, formato 'YYYY-MM-DD'.
 * @param {number} n
 * @returns {string}
 */
const daysAgo = (n) => addDays(today(), -n);

/**
 * Devuelve la fecha N días en el futuro, formato 'YYYY-MM-DD'.
 * @param {number} n
 * @returns {string}
 */
const daysFromNow = (n) => addDays(today(), n);

module.exports = { isoDate, today, daysAgo, daysFromNow };
