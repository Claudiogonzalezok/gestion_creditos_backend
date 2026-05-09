-- ── 004: Refresh tokens con rotación y detección de reutilización ────────────
-- family_id agrupa todos los tokens de una misma sesión. Si se detecta
-- reutilización de un token revocado se invalida toda la familia (theft detection).

CREATE TABLE IF NOT EXISTS public.refresh_tokens (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    token       VARCHAR(64)  NOT NULL UNIQUE,   -- SHA-256 hex del UUID raw (64 chars)
    family_id   UUID         NOT NULL,
    user_id     UUID         NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    customer_id UUID         NULL REFERENCES customers(id) ON UPDATE CASCADE ON DELETE CASCADE,
    revoked     BOOLEAN      NOT NULL DEFAULT FALSE,
    revoked_at  TIMESTAMPTZ  NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ  NOT NULL,
    CONSTRAINT refresh_tokens_owner_check
        CHECK (
            (user_id IS NOT NULL AND customer_id IS NULL) OR
            (user_id IS NULL     AND customer_id IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS idx_rt_token    ON refresh_tokens(token);
CREATE INDEX IF NOT EXISTS idx_rt_family   ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_rt_user     ON refresh_tokens(user_id)     WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rt_customer ON refresh_tokens(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rt_expires  ON refresh_tokens(expires_at);

-- Nuevos parámetros de configuración (no pisa los valores existentes)
INSERT INTO system_config (key, value, description) VALUES
  ('rt_expiry_internal_days', '7', 'Expiración refresh token sistema interno (días)'),
  ('rt_expiry_portal_days',   '1', 'Expiración refresh token portal público (días)')
ON CONFLICT (key) DO NOTHING;
