-- ── 046: mora automática deshabilitada (penalty_rate_daily = 0) ──────────────
--
-- Pedido del cliente: el sistema NO debe calcular punitorios automáticos por
-- el momento. Con la tasa diaria en 0:
--   · El cron de mora sigue marcando las cuotas vencidas como OVERDUE (la
--     mora sigue siendo VISIBLE en planillas y listados), pero el recargo
--     calculado es exactamente $0.
--   · Las moras cargadas MANUALMENTE no se tocan: la fórmula del cron suma
--     sobre el penalty_amount acumulado (con tasa 0 suma 0) y las cuotas cuyo
--     penalty supera el tope quedan directamente fuera de la corrida.
--   · Si el cliente decide reactivarla, se edita desde Configuración →
--     Parámetros del sistema; la mora corre solo desde ese día en adelante
--     (sin retroactivo, protegido por last_penalty_applied_at).
--
-- El default de código (seed + reset-to-default) también pasa a '0' en este
-- mismo cambio; esta migración alinea las bases YA sembradas con 0.005.

UPDATE system_config
SET value = '0',
    description = 'Porcentaje diario de mora (0 = sin mora automática, decisión del cliente; ej: 0.005 = 0.5%)',
    updated_at = NOW()
WHERE key = 'penalty_rate_daily'
  AND value = '0.005';
