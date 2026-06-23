-- ── 039: sistema de notificaciones (push in-app + email) ──────────────────
--
-- Introduce dos tablas nuevas:
--   · notifications              → historial/push de notificaciones por usuario.
--   · notification_preferences   → configuración GLOBAL por tipo de notificación
--                                   (V1: una sola fila por tipo, no por usuario).
--
-- 6 tipos de notificación soportados (CHECK explícito en ambas tablas):
--   MORA, INSTALLMENT_DUE, APPROVAL_REQUEST, CASH_REGISTER, NEW_CUSTOMER,
--   WEEKLY_REPORT.
--
--
-- Idempotencia: CREATE TABLE IF NOT EXISTS + INSERT...WHERE NOT EXISTS para el
-- seed. Re-ejecutar la migración no rompe el estado convergente.

CREATE TABLE IF NOT EXISTS public.notifications (
    id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID            NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE,
    type        VARCHAR(30)     NOT NULL
                    CONSTRAINT notifications_type_check
                    CHECK (type IN (
                        'MORA','INSTALLMENT_DUE','APPROVAL_REQUEST',
                        'CASH_REGISTER','NEW_CUSTOMER','WEEKLY_REPORT'
                    )),
    title       VARCHAR(150)    NOT NULL,
    message     TEXT            NOT NULL,
    read_at     TIMESTAMPTZ     NULL,
    entity_type VARCHAR(40)     NULL,
    entity_id   UUID            NULL,
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON public.notifications (user_id, read_at);

CREATE INDEX IF NOT EXISTS idx_notifications_created
    ON public.notifications (created_at);

CREATE TABLE IF NOT EXISTS public.notification_preferences (
    id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    type          VARCHAR(30)   NOT NULL UNIQUE
                      CONSTRAINT notification_preferences_type_check
                      CHECK (type IN (
                          'MORA','INSTALLMENT_DUE','APPROVAL_REQUEST',
                          'CASH_REGISTER','NEW_CUSTOMER','WEEKLY_REPORT'
                      )),
    enabled       BOOLEAN       NOT NULL DEFAULT TRUE,
    email_enabled BOOLEAN       NOT NULL DEFAULT FALSE,
    frequency     VARCHAR(20)   NOT NULL DEFAULT 'INSTANT'
                      CONSTRAINT notification_preferences_frequency_check
                      CHECK (frequency IN ('INSTANT','DAILY','WEEKLY')),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Seed: una fila por tipo con los valores default (enabled=true, email_enabled=false).
INSERT INTO public.notification_preferences (type, enabled, email_enabled, frequency)
SELECT v.type, TRUE, FALSE, v.frequency
FROM (VALUES
    ('MORA',             'INSTANT'),
    ('INSTALLMENT_DUE',  'INSTANT'),
    ('APPROVAL_REQUEST', 'INSTANT'),
    ('CASH_REGISTER',    'INSTANT'),
    ('NEW_CUSTOMER',     'INSTANT'),
    ('WEEKLY_REPORT',    'WEEKLY')
) AS v(type, frequency)
WHERE NOT EXISTS (
    SELECT 1 FROM public.notification_preferences p WHERE p.type = v.type
);

-- ── DOWN ────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_notifications_created;
-- DROP INDEX IF EXISTS idx_notifications_user_unread;
-- DROP TABLE IF EXISTS public.notification_preferences;
-- DROP TABLE IF EXISTS public.notifications;
