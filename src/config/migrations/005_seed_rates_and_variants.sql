-- ============================================================
--  MIGRACIÓN 005 — Seed de tasas WEEKLY/BIWEEKLY + variantes
--  CR-11: interest_rates y product_rates para frecuencias faltantes
--  CR-16: product_variants con atributos color/size/capacity
-- ============================================================
-- ── CR-11A: interest_rates WEEKLY y BIWEEKLY ─────────────────
-- Tasas genéricas para préstamos personales (LOAN).
-- Columnas: payment_frequency, installments_count, min_amount, max_amount, rate, active
-- WEEKLY: cuotas semanales (4, 8, 12, 16, 24)
-- BIWEEKLY: cuotas quincenales (2, 4, 6, 8, 12, 24)
INSERT INTO
    public.interest_rates (
        payment_frequency,
        installments_count,
        min_amount,
        max_amount,
        rate,
        active
    )
VALUES
    -- WEEKLY
    ('WEEKLY', 4, 0, 50000, 0.0800, TRUE),
    ('WEEKLY', 8, 0, 50000, 0.1000, TRUE),
    ('WEEKLY', 12, 0, 100000, 0.1200, TRUE),
    ('WEEKLY', 16, 0, 100000, 0.1400, TRUE),
    ('WEEKLY', 24, 0, 200000, 0.1600, TRUE),
    -- BIWEEKLY
    ('BIWEEKLY', 2, 0, 50000, 0.0600, TRUE),
    ('BIWEEKLY', 4, 0, 50000, 0.0800, TRUE),
    ('BIWEEKLY', 6, 0, 100000, 0.1000, TRUE),
    ('BIWEEKLY', 8, 0, 100000, 0.1200, TRUE),
    ('BIWEEKLY', 12, 0, 150000, 0.1400, TRUE),
    ('BIWEEKLY', 24, 0, 200000, 0.1600, TRUE) ON CONFLICT (
        payment_frequency,
        installments_count,
        min_amount,
        max_amount
    ) DO NOTHING;

-- ── CR-11B: product_rates WEEKLY y BIWEEKLY ──────────────────
-- Para cada producto activo que ya tenga rates MONTHLY,
-- copia esas combinaciones adaptando la frecuencia y ajustando la tasa.
-- WEEKLY:   tasa MONTHLY × 0.30  (cuotas más cortas = menor carga por cuota)
-- BIWEEKLY: tasa MONTHLY × 0.55
INSERT INTO
    public.product_rates (
        product_id,
        payment_frequency,
        installments_count,
        rate,
        active
    )
SELECT
    pr.product_id,
    'WEEKLY' AS payment_frequency,
    pr.installments_count,
    ROUND(pr.rate * 0.30, 4) AS rate,
    TRUE AS active
FROM
    public.product_rates pr
WHERE
    pr.payment_frequency = 'MONTHLY'
    AND pr.active = TRUE ON CONFLICT (
        product_id,
        payment_frequency,
        installments_count
    ) DO NOTHING;

INSERT INTO
    public.product_rates (
        product_id,
        payment_frequency,
        installments_count,
        rate,
        active
    )
SELECT
    pr.product_id,
    'BIWEEKLY' AS payment_frequency,
    pr.installments_count,
    ROUND(pr.rate * 0.55, 4) AS rate,
    TRUE AS active
FROM
    public.product_rates pr
WHERE
    pr.payment_frequency = 'MONTHLY'
    AND pr.active = TRUE ON CONFLICT (
        product_id,
        payment_frequency,
        installments_count
    ) DO NOTHING;

-- ── CR-16: product_variants con atributos ────────────────────
-- Agrega variantes con color/size/capacity para cada producto ACTIVE
-- que solo tenga la variante estándar (color, size, capacity todos NULL).
-- Mantiene la "Variante estándar" intacta.
-- Precio base: toma el current_price de la variante estándar del mismo producto.
DO $ $ DECLARE r RECORD;

BEGIN FOR r IN
SELECT
    DISTINCT pv.product_id,
    pv.current_price
FROM
    public.product_variants pv
    JOIN public.products p ON p.id = pv.product_id
WHERE
    p.status = 'ACTIVE'
    AND pv.status = 'ACTIVE'
    AND pv.color IS NULL
    AND pv.size IS NULL
    AND pv.capacity IS NULL LOOP -- Variante: color Negro, talla M
INSERT INTO
    public.product_variants (
        product_id,
        color,
        size,
        capacity,
        current_price,
        status
    )
VALUES
    (
        r.product_id,
        'Negro',
        'M',
        NULL,
        r.current_price,
        'ACTIVE'
    ) ON CONFLICT DO NOTHING;

-- Variante: color Blanco, talla M
INSERT INTO
    public.product_variants (
        product_id,
        color,
        size,
        capacity,
        current_price,
        status
    )
VALUES
    (
        r.product_id,
        'Blanco',
        'M',
        NULL,
        r.current_price,
        'ACTIVE'
    ) ON CONFLICT DO NOTHING;

-- Variante: color Plateado
INSERT INTO
    public.product_variants (
        product_id,
        color,
        size,
        capacity,
        current_price,
        status
    )
VALUES
    (
        r.product_id,
        'Plateado',
        NULL,
        NULL,
        r.current_price,
        'ACTIVE'
    ) ON CONFLICT DO NOTHING;

END LOOP;

END $ $;