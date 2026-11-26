-- 053 · Datos de la empresa y tasas de referencia (issue #88).
-- · company_settings: una sola fila (id = 1) con los datos de contacto que
--   muestra la pantalla de configuración. updated_by sin FK a users a
--   propósito: un TRUNCATE ... CASCADE de users no debe borrar estos datos.
-- · Tasas de referencia mensuales VENTA/PRÉSTAMO en system_config (no
--   reemplazan product_rates/interest_rates). Mora, comisión y gracia reusan
--   las claves existentes penalty_rate_daily, commission_rate y
--   penalty_grace_days.
-- Aditiva e idempotente.

CREATE TABLE IF NOT EXISTS public.company_settings (
    id             SMALLINT        PRIMARY KEY DEFAULT 1
                       CONSTRAINT company_settings_singleton CHECK (id = 1),
    system_name    VARCHAR(150)    NOT NULL DEFAULT 'FinFlow',
    contact_email  VARCHAR(150)    NULL,
    phone          VARCHAR(30)     NULL,
    address        VARCHAR(255)    NULL,
    updated_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_by     UUID            NULL
);

INSERT INTO public.company_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO system_config (key, value, description) VALUES
  ('company_sale_rate_monthly', '0', 'Tasa mensual de referencia para VENTA (datos de empresa; no reemplaza product_rates)'),
  ('company_loan_rate_monthly', '0', 'Tasa mensual de referencia para PRÉSTAMO (datos de empresa; no reemplaza interest_rates)')
ON CONFLICT (key) DO NOTHING;

-- ── DOWN ────────────────────────────────────────────────────────────────────
-- DELETE FROM system_config WHERE key IN ('company_sale_rate_monthly','company_loan_rate_monthly');
-- DROP TABLE IF EXISTS public.company_settings;
