/**
 * Calcula el monto por cuota redondeado hacia arriba a 2 decimales.
 */
const getInstallmentAmount = (totalAmount, interestRate, installmentsCount) => {
  const totalWithInterest = totalAmount * (1 + interestRate);
  return Math.ceil((totalWithInterest / installmentsCount) * 100) / 100;
};

/**
 * Calcula el total a pagar con intereses incluidos.
 */
const getTotalWithInterest = (totalAmount, interestRate) => {
  return Math.round(totalAmount * (1 + interestRate) * 100) / 100;
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

module.exports = { getInstallmentAmount, getTotalWithInterest, getDueDates, getWeekBounds };
