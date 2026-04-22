// Semilla 02 — Parámetros del sistema
// Sincronizados con DEFAULT_VALUES en systemConfig.queries.js
const pool = require('../config/db');

const configs = [
  { key: 'commission_rate',           value: '0.08',   description: 'Tasa de comisión por venta (0.08 = 8%)' },
  { key: 'penalty_grace_days',        value: '3',      description: 'Días de gracia antes de aplicar mora' },
  { key: 'penalty_rate_daily',        value: '0.005',  description: 'Porcentaje diario de mora (0.005 = 0.5%)' },
  { key: 'penalty_max_rate',          value: '0.50',   description: 'Tope máximo de mora acumulable (0.50 = 50%)' },
  { key: 'credit_expiry_days',        value: '7',      description: 'Días en PENDING_APPROVAL antes de expirar' },
  { key: 'min_credit_amount',         value: '1000',   description: 'Monto mínimo en el cotizador' },
  { key: 'max_credit_amount',         value: '500000', description: 'Monto máximo en el cotizador' },
  { key: 'jwt_expiry_internal_hs',    value: '8',      description: 'Expiración JWT sistema interno (horas)' },
  { key: 'jwt_expiry_portal_min',     value: '30',     description: 'Expiración JWT portal público (minutos)' },
  { key: 'login_max_attempts',        value: '3',      description: 'Intentos fallidos antes del bloqueo' },
  { key: 'commission_week_close_day', value: '6',      description: 'Día de cierre del ciclo semanal (ISO: 6=Sáb)' },
  { key: 'commission_pay_day',        value: '1',      description: 'Día de pago de liquidaciones (ISO: 1=Lun)' },
];

const seed = async () => {
  console.log('  Cargando parámetros del sistema...');
  for (const cfg of configs) {
    await pool.query(
      `INSERT INTO system_config (key, value, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE
         SET value       = EXCLUDED.value,
             description = EXCLUDED.description,
             updated_at  = NOW()`,
      [cfg.key, cfg.value, cfg.description]
    );
  }
  console.log(`   ✅  ${configs.length} parámetros cargados.`);
};

module.exports = seed;
