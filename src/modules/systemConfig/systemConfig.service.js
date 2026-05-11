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
};

const getAll = async () => queries.findAll();

const getByKey = async (key) => {
  const param = await queries.findByKey(key);
  if (!param) throw { status: 404, message: 'Parámetro no encontrado.' };
  return param;
};

const update = async (key, value, userId) => {
  const param = await queries.findByKey(key);
  if (!param) throw { status: 404, message: 'Parámetro no encontrado.' };

  const num   = parseFloat(value);
  const range = VALID_RANGES[key];
  if (isNaN(num)) throw { status: 400, message: 'El valor debe ser numérico.' };
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

  return queries.update(key, String(value), userId);
};

const resetToDefault = async (key, userId) => {
  const param = await queries.findByKey(key);
  if (!param) throw { status: 404, message: 'Parámetro no encontrado.' };
  return queries.resetToDefault(key, userId);
};

module.exports = { getAll, getByKey, update, resetToDefault };
