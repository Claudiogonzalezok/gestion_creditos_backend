/**
 * Utilidades de dinero exacto: todo cálculo intermedio se hace en centavos
 * enteros para evitar los desfasajes de punto flotante (ej. 1.005 → 1.00 o
 * 0.1 + 0.2 = 0.30000000000000004).
 *
 * Solo afecta cálculos nuevos; no recalcula montos ya persistidos.
 */

/**
 * Convierte un monto (number o string numérico) a centavos enteros, redondeando
 * medio centavo hacia afuera del cero (1.005 → 101, -1.005 → -101).
 * @param {number|string|null|undefined} value - Monto en unidades monetarias.
 * @returns {number} Centavos enteros (0 si el valor no es numérico).
 */
const toCents = (value) => {
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  const abs = Math.abs(n);
  // toFixed(8) descarta el ruido binario (1.005 → "1.00500000") y el
  // desplazamiento de coma se hace en notación decimal, sin multiplicar en flotante.
  const cents = Math.round(Number(`${abs.toFixed(8)}e2`));
  return n < 0 ? -cents : cents;
};

/**
 * Convierte centavos enteros a unidades monetarias.
 * @param {number} cents - Centavos enteros.
 * @returns {number} Monto con a lo sumo 2 decimales.
 */
const fromCents = (cents) => cents / 100;

/**
 * Redondea un monto a 2 decimales de forma exacta (medio centavo hacia afuera del cero).
 * @param {number|string} value - Monto a redondear.
 * @returns {number} Monto redondeado.
 */
const round2 = (value) => fromCents(toCents(value));

/**
 * Suma montos en centavos y devuelve el total exacto a 2 decimales.
 * @param {...(number|string)} values - Montos a sumar.
 * @returns {number} Suma exacta.
 */
const addMoney = (...values) =>
  fromCents(values.reduce((acc, v) => acc + toCents(v), 0));

/**
 * Resta dos montos en centavos (a - b).
 * @returns {number} Diferencia exacta.
 */
const subtractMoney = (a, b) => fromCents(toCents(a) - toCents(b));

/**
 * Reparte un total en `count` partes cuya suma es exactamente el total.
 * Cada parte recibe el cociente entero de centavos y el resto se reparte de a un
 * centavo en las primeras partes: las partes difieren a lo sumo en 1 centavo.
 * @param {number|string} total - Monto a repartir.
 * @param {number} count - Cantidad de partes (> 0).
 * @returns {number[]} Partes en unidades monetarias.
 */
const splitMoney = (total, count) => {
  const n = parseInt(count, 10);
  if (!Number.isInteger(n) || n <= 0) return [];
  const totalCents = toCents(total);
  const base = Math.trunc(totalCents / n);
  const rest = totalCents - base * n;
  const step = Math.sign(rest);
  return Array.from({ length: n }, (_, i) =>
    fromCents(base + (i < Math.abs(rest) ? step : 0)),
  );
};

/**
 * Interpreta un monto opcional recibido por API: vacío vale 0 y un valor no
 * numérico o infinito lanza 400 en vez de convertirse silenciosamente en 0.
 * @param {*} value - Valor recibido.
 * @param {string} label - Nombre del campo para el mensaje de error.
 * @returns {number} Monto redondeado a centavos.
 * @throws {{ status: 400, message: string }} si el valor no es numérico.
 */
const parseMoneyInput = (value, label) => {
  if (value === undefined || value === null || String(value).trim() === "")
    return 0;
  const n = Number(value);
  if (!Number.isFinite(n))
    throw { status: 400, message: `${label} deben ser un monto numérico válido.` };
  return round2(n);
};

module.exports = {
  parseMoneyInput,
  toCents,
  fromCents,
  round2,
  addMoney,
  subtractMoney,
  splitMoney,
};
