-- 054 · Recuperación de contraseña por token (issue #88).
-- · password_reset_tokens: token de un solo uso, guardado como hash SHA-256
--   (nunca en claro), con vencimiento. used_at marca el consumo.
-- Aditiva e idempotente.

CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
    id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID          NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    token_hash   CHAR(64)      NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ   NOT NULL,
    used_at      TIMESTAMPTZ   NULL,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
    ON public.password_reset_tokens (user_id) WHERE used_at IS NULL;

INSERT INTO system_config (key, value, description)
VALUES ('password_reset_expiry_min', '30', 'Minutos de validez del enlace de recuperación de contraseña')
ON CONFLICT (key) DO NOTHING;

-- ── DOWN ────────────────────────────────────────────────────────────────────
-- DELETE FROM system_config WHERE key = 'password_reset_expiry_min';
-- DROP TABLE IF EXISTS public.password_reset_tokens;
