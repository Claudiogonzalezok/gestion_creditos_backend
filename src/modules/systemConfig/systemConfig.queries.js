const pool = require('../../config/db');

const DEFAULT_VALUES = {
  commission_rate:           { value: '0.08',   description: 'Tasa de comisión por venta (0.08 = 8%)' },
  penalty_grace_days:        { value: '3',      description: 'Días de gracia antes de aplicar mora' },
  penalty_rate_daily:        { value: '0.005',  description: 'Porcentaje diario de mora (0.005 = 0.5%)' },
  penalty_max_rate:          { value: '0.50',   description: 'Tope máximo de mora acumulable (0.50 = 50%)' },
  credit_expiry_days:        { value: '7',      description: 'Días en PENDING_APPROVAL antes de expirar' },
  min_credit_amount:         { value: '1000',   description: 'Monto mínimo en el cotizador' },
  max_credit_amount:         { value: '500000', description: 'Monto máximo en el cotizador' },
  jwt_expiry_internal_hs:    { value: '8',      description: 'Expiración JWT sistema interno (horas)' },
  jwt_expiry_portal_min:     { value: '30',     description: 'Expiración JWT portal público (minutos)' },
  login_max_attempts:        { value: '3',      description: 'Intentos fallidos antes del bloqueo' },
  commission_week_close_day: { value: '6',      description: 'Día de cierre del ciclo semanal (ISO: 6=Sáb)' },
  commission_pay_day:        { value: '1',      description: 'Día de pago de liquidaciones (ISO: 1=Lun)' },
};

const findAll = async () => {
  const result = await pool.query(
    `SELECT key, value, description, updated_at, updated_by
     FROM system_config ORDER BY key ASC`
  );
  return result.rows;
};

const findByKey = async (key) => {
  const result = await pool.query(
    `SELECT key, value, description, updated_at, updated_by
     FROM system_config WHERE key = $1`,
    [key]
  );
  return result.rows[0] || null;
};

const update = async (key, value, userId) => {
  const result = await pool.query(
    `UPDATE system_config
     SET value = $1, updated_at = NOW(), updated_by = $2
     WHERE key = $3
     RETURNING key, value, description, updated_at`,
    [value, userId, key]
  );
  return result.rows[0] || null;
};

const resetToDefault = async (key, userId) => {
  const def = DEFAULT_VALUES[key];
  if (!def) return null;
  const result = await pool.query(
    `UPDATE system_config
     SET value = $1, updated_at = NOW(), updated_by = $2
     WHERE key = $3
     RETURNING key, value, description, updated_at`,
    [def.value, userId, key]
  );
  return result.rows[0] || null;
};

// Utilitario para que otros módulos lean un parámetro directamente
const getValue = async (key) => {
  const result = await pool.query(
    `SELECT value FROM system_config WHERE key = $1`, [key]
  );
  return result.rows[0]?.value ?? DEFAULT_VALUES[key]?.value ?? null;
};

module.exports = { findAll, findByKey, update, resetToDefault, getValue, DEFAULT_VALUES };
