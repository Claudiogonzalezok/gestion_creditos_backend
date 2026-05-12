const pool = require("../config/db");

/**
 * Convierte una fecha a clave local YYYY-MM-DD para comparación de calendario.
 * @param {Date|string} date - Fecha a normalizar.
 * @returns {string} Fecha local en formato YYYY-MM-DD.
 */
const toDateKey = (date) => {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

/**
 * Determina si una fecha cae en fin de semana.
 * @param {Date|string} date - Fecha evaluada.
 * @returns {boolean} true si es sábado o domingo.
 */
const isWeekend = (date) => {
  const day = new Date(date).getDay();
  return day === 0 || day === 6;
};

/**
 * Evalúa si una fecha es hábil considerando fines de semana y feriados activos.
 * @param {Date|string} date - Fecha evaluada.
 * @param {Set<string>} holidayKeys - Set con fechas YYYY-MM-DD no hábiles por feriado.
 * @returns {boolean} true si la fecha es hábil.
 */
const isBusinessDay = (date, holidayKeys = new Set()) => {
  const key = toDateKey(date);
  return !isWeekend(date) && !holidayKeys.has(key);
};

/**
 * Corre una fecha hacia el próximo día hábil (incluyendo la fecha actual si ya es hábil).
 * @param {Date|string} date - Fecha base.
 * @param {Set<string>} holidayKeys - Set con fechas de feriados activos.
 * @returns {Date} Fecha ajustada al siguiente día hábil.
 */
const moveToNextBusinessDay = (date, holidayKeys = new Set()) => {
  const result = new Date(date);
  result.setHours(12, 0, 0, 0);

  while (!isBusinessDay(result, holidayKeys)) {
    result.setDate(result.getDate() + 1);
  }

  return result;
};

/**
 * Ajusta una lista de fechas de vencimiento al próximo día hábil.
 * @param {Date[]} dueDates - Fechas calculadas por frecuencia base.
 * @param {Set<string>} holidayKeys - Set con fechas de feriados activos.
 * @returns {Date[]} Fechas ajustadas respetando días hábiles.
 */
const adjustDueDatesToBusinessDays = (dueDates, holidayKeys = new Set()) =>
  dueDates.map((date) => moveToNextBusinessDay(date, holidayKeys));

/**
 * Obtiene los feriados activos que afectan vencimientos dentro de un rango.
 * @param {Date|string} fromDate - Inicio del rango.
 * @param {Date|string} toDate - Fin del rango.
 * @returns {Promise<Set<string>>} Set de fechas YYYY-MM-DD afectadas por feriados activos.
 */
const getActiveHolidayKeysInRange = async (fromDate, toDate) => {
  const from = toDateKey(fromDate);
  const to = toDateKey(toDate);
  const r = await pool.query(
    `SELECT date
     FROM holidays
     WHERE active = TRUE
       AND affects_due_dates = TRUE
       AND date BETWEEN $1::date AND $2::date`,
    [from, to],
  );
  return new Set(r.rows.map((row) => toDateKey(row.date)));
};

module.exports = {
  toDateKey,
  isWeekend,
  isBusinessDay,
  moveToNextBusinessDay,
  adjustDueDatesToBusinessDays,
  getActiveHolidayKeysInRange,
};
