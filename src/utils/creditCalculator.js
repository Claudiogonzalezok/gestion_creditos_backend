const { localDate } = require("./date");

/**
 * Convierte un input de fecha YYYY-MM-DD a Date local sin sesgo UTC.
 * @param {string|Date|null} value - Fecha recibida desde API o UI.
 * @returns {Date|null} Instancia local lista para cálculos de calendario.
 */
const parseLocalDateInput = (value) => {
  if (!value) return null;
  if (value instanceof Date) return new Date(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(value);
};

/**
 * Suma meses calendario conservando el día del mes del ancla.
 * Si el mes destino es más corto que el día ancla (ej. 31 sobre febrero), se
 * recorta al último día de ese mes (clamp), igual que `date + interval '1 month'`
 * en PostgreSQL. Así el cálculo en JS y el de SQL (shiftInstallmentDates)
 * coinciden exactamente.
 * @param {Date} baseDate - Fecha ancla.
 * @param {number} periods - Cantidad de meses a sumar.
 * @returns {Date} Fecha desplazada con día ancla preservado o recortado.
 */
const addMonthsClamped = (baseDate, periods) => {
  const day = baseDate.getDate();
  const due = new Date(
    baseDate.getFullYear(),
    baseDate.getMonth() + periods,
    1,
    12,
    0,
    0,
    0,
  );
  // 0 días del mes siguiente = último día del mes destino.
  const lastDay = new Date(due.getFullYear(), due.getMonth() + 1, 0).getDate();
  due.setDate(Math.min(day, lastDay));
  return due;
};

/**
 * Aplica el avance de período para una frecuencia de pago sobre una fecha base.
 * DIARIA avanza 1 día corrido por período. MENSUAL avanza por mes calendario
 * (mismo día de cada mes), no por 30 días corridos: si se ancla un día 24, todas
 * las cuotas vencen el 24. Cada frecuencia es una rama explícita; una frecuencia
 * desconocida lanza error (nunca cae silenciosamente en mensual).
 * @param {Date} baseDate - Fecha desde la cual se aplica el desplazamiento.
 * @param {'DAILY'|'WEEKLY'|'BIWEEKLY'|'MONTHLY'} frequency - Frecuencia del plan.
 * @param {number} periods - Cantidad de períodos a mover.
 * @returns {Date} Nueva fecha desplazada.
 */
const addFrequencyPeriods = (baseDate, frequency, periods) => {
  const due = new Date(baseDate);
  if (frequency === "DAILY") {
    due.setDate(baseDate.getDate() + 1 * periods);
    return due;
  }
  if (frequency === "WEEKLY") {
    due.setDate(baseDate.getDate() + 7 * periods);
    return due;
  }
  if (frequency === "BIWEEKLY") {
    due.setDate(baseDate.getDate() + 14 * periods);
    return due;
  }
  if (frequency === "MONTHLY") {
    return addMonthsClamped(baseDate, periods);
  }
  throw new Error(`Frecuencia de pago no soportada: ${frequency}`);
};

/**
 * Ajusta un conjunto de vencimientos al próximo día hábil.
 * No altera el cálculo base de frecuencia, solo normaliza fines de semana/feriados.
 * @param {Date[]} dueDates - Fechas base calculadas por frecuencia.
 * @param {(date: Date) => Date} moveToNextBusinessDayFn - Función de corrimiento al próximo hábil.
 * @returns {Date[]} Fechas de vencimiento ajustadas.
 */
const adjustDueDatesWithBusinessDayRule = (dueDates, moveToNextBusinessDayFn) =>
  dueDates.map((dueDate) => moveToNextBusinessDayFn(dueDate));

/**
 * Calcula el monto por cuota redondeado hacia arriba al millar más cercano.
 * Todas las cuotas son iguales entre sí.
 *
 * Fórmula:
 *   Monto total = monto + (monto × coeficiente)
 *   Cuota       = ceil(Monto total / cantidad / 1000) × 1000
 */
const getInstallmentAmount = (totalAmount, coefficient, installmentsCount) => {
  const amount = parseFloat(totalAmount);
  const coef = parseFloat(coefficient);
  const count = parseInt(installmentsCount);
  const totalWithInterest = amount * (1 + coef);
  const rawInstallment = Math.round((totalWithInterest / count) * 100) / 100;
  return Math.ceil(rawInstallment / 1000) * 1000;
};

/**
 * Calcula el monto total matemático antes del redondeo de cuotas.
 * Útil para mostrar el interés generado.
 */
const getTotalWithInterest = (totalAmount, coefficient) => {
  const amount = parseFloat(totalAmount);
  const coef = parseFloat(coefficient);
  return Math.round(amount * (1 + coef) * 100) / 100;
};

/**
 * Calcula el monto total real a devolver: cuota redondeada × cantidad de cuotas.
 * Puede diferir levemente del total matemático por el redondeo al millar.
 */
const getTotalToReturn = (totalAmount, coefficient, installmentsCount) => {
  const count = parseInt(installmentsCount);
  return getInstallmentAmount(totalAmount, coefficient, count) * count;
};

/**
 * Genera un array de fechas de vencimiento.
 * La primera cuota vence 1 período después de la fecha de aprobación.
 */
const getDueDates = (startDate, installmentsCount, frequency) => {
  const dates = [];
  const base = new Date(startDate);
  base.setHours(12, 0, 0, 0);

  for (let i = 1; i <= installmentsCount; i++) {
    dates.push(addFrequencyPeriods(base, frequency, i));
  }
  return dates;
};

/**
 * Genera vencimientos tomando una primera fecha explícita como ancla.
 * Si no se informa, reutiliza la lógica histórica basada en la fecha actual.
 * @param {string|Date|null} firstPaymentDate - Primera fecha de pago elegida.
 * @param {number} installmentsCount - Cantidad total de cuotas.
 * @param {'DAILY'|'WEEKLY'|'BIWEEKLY'|'MONTHLY'} frequency - Frecuencia del plan.
 * @returns {Date[]} Fechas de vencimiento calculadas.
 */
const getDueDatesFromFirstPayment = (
  firstPaymentDate,
  installmentsCount,
  frequency,
) => {
  if (!firstPaymentDate) {
    return getDueDates(new Date(), installmentsCount, frequency);
  }

  const dates = [];
  const base = parseLocalDateInput(firstPaymentDate);
  base.setHours(12, 0, 0, 0);

  for (let i = 0; i < installmentsCount; i++) {
    dates.push(addFrequencyPeriods(base, frequency, i));
  }
  return dates;
};

/**
 * Devuelve el lunes y sábado de la semana que contiene la fecha dada.
 * Retorna strings 'YYYY-MM-DD' para uso directo en SQL.
 */
const getWeekBounds = (date = new Date()) => {
  const d = new Date(date);
  const day = d.getDay(); // 0=Dom
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);

  const saturday = new Date(monday);
  saturday.setDate(monday.getDate() + 5);
  saturday.setHours(23, 59, 59, 999);

  return {
    week_start: localDate(monday),
    week_end: localDate(saturday),
  };
};

/**
 * Calcula la contribución a la cuota de un ítem de venta a crédito.
 * lineTotal = historical_price × quantity
 * El redondeo al millar se aplica por producto, igual que en getInstallmentAmount.
 */
const getProductInstallmentContribution = (
  lineTotal,
  rate,
  installmentsCount,
) => getInstallmentAmount(lineTotal, rate, installmentsCount);

module.exports = {
  getInstallmentAmount,
  getTotalWithInterest,
  getTotalToReturn,
  addFrequencyPeriods,
  adjustDueDatesWithBusinessDayRule,
  getDueDates,
  getDueDatesFromFirstPayment,
  getWeekBounds,
  getProductInstallmentContribution,
};
