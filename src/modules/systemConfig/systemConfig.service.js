const queries = require('./systemConfig.queries');

const VALID_RANGES = {
  commission_rate:           { min: 0,    max: 1        },
  penalty_grace_days:        { min: 0,    max: 30       },
  penalty_rate_daily:        { min: 0,    max: 0.5      },
  penalty_max_rate:          { min: 0,    max: 1        },
  credit_expiry_days:        { min: 1,    max: 365      },
  min_credit_amount:         { min: 1,    max: 999999   },
  max_credit_amount:         { min: 1,    max: 99999999 },
  jwt_expiry_internal_hs:    { min: 0.08, max: 72       },
  jwt_expiry_portal_min:     { min: 5,    max: 1440     },
  login_max_attempts:        { min: 1,    max: 10       },
  commission_week_close_day: { min: 1,    max: 7        },
  commission_pay_day:        { min: 1,    max: 7        },
  company_sale_rate_monthly: { min: 0,    max: 1        },
  company_loan_rate_monthly: { min: 0,    max: 1        },
  password_reset_expiry_min: { min: 5,    max: 1440     },};

// Decimal simple: dígitos con parte fraccionaria opcional y signo opcional.
// Rechaza notación científica, hexadecimal, sufijos ("12abc") y vacíos.
const STRICT_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * Convierte un valor de configuración a número de forma estricta.
 * A diferencia de parseFloat, no acepta basura al final ni tipos no escalares.
 * @param {*} value - valor recibido en el body
 * @returns {number|null} el número finito, o null si no es un decimal válido
 */
const parseStrictNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!STRICT_NUMBER_RE.test(trimmed)) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
};

const getAll = async () => queries.findAll();

const getByKey = async (key) => {
  const param = await queries.findByKey(key);
  if (!param) throw { status: 404, message: 'Parámetro no encontrado.' };
  return param;
};

/**
 * Valida el valor de un parámetro (numérico estricto, rango y validaciones
 * cruzadas). No verifica que la clave exista ni persiste nada.
 * @param {string} key - clave de system_config
 * @param {*} value - valor recibido
 * @returns {Promise<string>} el valor normalizado a guardar
 */
const validateValue = async (key, value) => {
  const num   = parseStrictNumber(value);
  const range = VALID_RANGES[key];
  if (num === null) throw { status: 400, message: 'El valor debe ser numérico.' };
  if (num < 0) throw { status: 400, message: 'El valor no puede ser negativo.' };
  if (range && (num < range.min || num > range.max))
    throw { status: 400, message: `El valor debe estar entre ${range.min} y ${range.max}.` };

  // Validaciones cruzadas entre parámetros relacionados
  if (key === 'min_credit_amount') {
    const maxVal = parseFloat(await queries.getValue('max_credit_amount'));
    if (num >= maxVal)
      throw { status: 400, message: 'El monto mínimo debe ser menor al monto máximo configurado.' };
  }
  if (key === 'max_credit_amount') {
    const minVal = parseFloat(await queries.getValue('min_credit_amount'));
    if (num <= minVal)
      throw { status: 400, message: 'El monto máximo debe ser mayor al monto mínimo configurado.' };
  }
  if (key === 'commission_week_close_day') {
    const payDay = parseInt(await queries.getValue('commission_pay_day'));
    if (num === payDay)
      throw { status: 400, message: 'El día de cierre no puede ser igual al día de pago de liquidaciones.' };
  }
  if (key === 'commission_pay_day') {
    const closeDay = parseInt(await queries.getValue('commission_week_close_day'));
    if (num === closeDay)
      throw { status: 400, message: 'El día de pago no puede ser igual al día de cierre del ciclo.' };
  }

  return String(num);
};

const update = async (key, value, userId) => {
  const param = await queries.findByKey(key);
  if (!param) throw { status: 404, message: 'Parámetro no encontrado.' };
  const normalized = await validateValue(key, value);
  return queries.update(key, normalized, userId);
};

/**
 * Actualiza varios parámetros de forma atómica: valida todos antes de
 * escribir y persiste en una única transacción.
 * @param {Object<string, *>} entries - { clave: valor }
 * @param {string} userId - usuario que realiza el cambio
 * @returns {Promise<object[]>} filas actualizadas
 */
const updateMany = async (entries, userId) => {
  const normalized = {};
  for (const [key, value] of Object.entries(entries)) {
    normalized[key] = await validateValue(key, value);
  }
  return queries.updateMany(normalized, userId);
};

const resetToDefault = async (key, userId) => {
  const param = await queries.findByKey(key);
  if (!param) throw { status: 404, message: 'Parámetro no encontrado.' };
  return queries.resetToDefault(key, userId);
};

module.exports = { getAll, getByKey, update, updateMany, validateValue, resetToDefault };
