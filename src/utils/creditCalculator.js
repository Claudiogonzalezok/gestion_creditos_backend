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
  const coef   = parseFloat(coefficient);
  const count  = parseInt(installmentsCount);
  const totalWithInterest = amount * (1 + coef);
  return Math.ceil((totalWithInterest / count) / 1000) * 1000;
};

/**
 * Calcula el monto total matemático antes del redondeo de cuotas.
 * Útil para mostrar el interés generado.
 */
const getTotalWithInterest = (totalAmount, coefficient) => {
  const amount = parseFloat(totalAmount);
  const coef   = parseFloat(coefficient);
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
  const base  = new Date(startDate);
  base.setHours(12, 0, 0, 0);

  for (let i = 1; i <= installmentsCount; i++) {
    const due = new Date(base);
    switch (frequency) {
      case 'WEEKLY':   due.setDate(base.getDate() + 7 * i);    break;
      case 'BIWEEKLY': due.setDate(base.getDate() + 14 * i);   break;
      case 'MONTHLY':  due.setMonth(base.getMonth() + i);       break;
    }
    dates.push(due);
  }
  return dates;
};

/**
 * Devuelve el lunes y sábado de la semana que contiene la fecha dada.
 * Retorna strings 'YYYY-MM-DD' para uso directo en SQL.
 */
const getWeekBounds = (date = new Date()) => {
  const d   = new Date(date);
  const day = d.getDay(); // 0=Dom
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);

  const saturday = new Date(monday);
  saturday.setDate(monday.getDate() + 5);
  saturday.setHours(23, 59, 59, 999);

  return {
    week_start: monday.toISOString().split('T')[0],
    week_end:   saturday.toISOString().split('T')[0],
  };
};

module.exports = { getInstallmentAmount, getTotalWithInterest, getTotalToReturn, getDueDates, getWeekBounds };
