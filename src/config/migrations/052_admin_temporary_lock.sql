-- 052 · Bloqueo temporal de ADMIN tras intentos fallidos (issue #35).
-- ADMIN nunca recibe bloqueo permanente (locked_at): se le aplica un bloqueo
-- por tiempo en locked_until. Aditiva e idempotente.

ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ NULL;

INSERT INTO system_config (key, value, description)
VALUES ('admin_lock_minutes', '15', 'Minutos de bloqueo temporal de un ADMIN tras superar los intentos fallidos')
ON CONFLICT (key) DO NOTHING;
