-- 054 · Recuperación de contraseña por token y aviso de mora a clientes (issue #88).
-- · password_reset_tokens: token de un solo uso, guardado como hash SHA-256
--   (nunca en claro), con vencimiento. used_at marca el consumo.
-- · customer_overdue_notices: auditoría de avisos de mora enviados al
--   cliente. Único por cuota y día (idempotencia del endpoint).
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

CREATE TABLE IF NOT EXISTS public.customer_overdue_notices (
    id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    installment_id  UUID           NOT NULL REFERENCES public.installments(id) ON UPDATE CASCADE,
    customer_id     UUID           NOT NULL REFERENCES public.customers(id) ON UPDATE CASCADE,
    channel         VARCHAR(20)    NOT NULL DEFAULT 'EMAIL'
                        CONSTRAINT customer_overdue_notices_channel_check CHECK (channel IN ('EMAIL')),
    recipient       VARCHAR(150)   NOT NULL,
    amount_due      NUMERIC(12,2)  NOT NULL,
    sent_by         UUID           NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE,
    notified_on     DATE           NOT NULL,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    CONSTRAINT customer_overdue_notices_once_per_day UNIQUE (installment_id, notified_on)
);

CREATE INDEX IF NOT EXISTS idx_customer_overdue_notices_customer
    ON public.customer_overdue_notices (customer_id, created_at);

-- ── DOWN ────────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.customer_overdue_notices;
-- DELETE FROM system_config WHERE key = 'password_reset_expiry_min';
-- DROP TABLE IF EXISTS public.password_reset_tokens;
