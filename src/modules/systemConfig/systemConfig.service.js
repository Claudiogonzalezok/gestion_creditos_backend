const queries = require('./systemConfig.queries');

const VALID_RANGES = {
  commission_rate:           { min: 0,    max: 1        },
  penalty_grace_days:        { min: 0,    max: 30       },
  penalty_rate_daily:        { min: 0,    max: 0.5      },
  penalty_max_rate:          { min: 0,    max: 1        },
  credit_expiry_days:        { min: 1,    max: 365      },
  min_credit_amount:         { min: 1,    max: 999999   },
  max_credit_amount:         { min: 1,    max: 99999999 },
  jwt_expiry_internal_hs:    { min: 1,    max: 72       },
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

  return queries.update(key, String(value), userId);
};

const resetToDefault = async (key, userId) => {
  const param = await queries.findByKey(key);
  if (!param) throw { status: 404, message: 'Parámetro no encontrado.' };
  return queries.resetToDefault(key, userId);
};

module.exports = { getAll, getByKey, update, resetToDefault };
