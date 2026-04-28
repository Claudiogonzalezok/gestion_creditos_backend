-- ============================================================
--  MIGRACIÓN 001 — Estructura completa de la base de datos
--  Sistema de Gestión de Préstamos y Ventas a Crédito
--  Versión consolidada — Abril 2026
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── 1. users ─────────────────────────────────────────────────
CREATE TABLE public.users (
    id               UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name        VARCHAR(150)    NOT NULL,
    dni              VARCHAR(9)      NOT NULL UNIQUE,
    email            VARCHAR(150)    NULL,
    password_hash    VARCHAR(255)    NOT NULL,
    role             VARCHAR(20)     NOT NULL
                         CONSTRAINT users_role_check
                         CHECK (role IN ('ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR')),
    status           VARCHAR(20)     NOT NULL DEFAULT 'ACTIVE'
                         CONSTRAINT users_status_check
                         CHECK (status IN ('ACTIVE','INACTIVE')),
    is_temp_password BOOLEAN         NOT NULL DEFAULT TRUE,
    failed_attempts  SMALLINT        NOT NULL DEFAULT 0
                         CONSTRAINT users_failed_attempts_check CHECK (failed_attempts >= 0),
    locked_at        TIMESTAMPTZ     NULL,
    last_login_at    TIMESTAMPTZ     NULL,
    force_relogin_at TIMESTAMPTZ     NULL,
    address          VARCHAR(50)     NULL,
    created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_users_dni    ON users(dni);
CREATE INDEX idx_users_role   ON users(role);
CREATE INDEX idx_users_status ON users(status);

-- ── 2. customers ─────────────────────────────────────────────
CREATE TABLE public.customers (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name               VARCHAR(150)    NOT NULL,
    dni                     VARCHAR(10)     NOT NULL UNIQUE,
    address                 VARCHAR(255)    NULL,
    phone                   VARCHAR(30)     NULL,
    email                   VARCHAR(150)    NULL,
    status                  VARCHAR(20)     NOT NULL DEFAULT 'ACTIVE'
                                CONSTRAINT customers_status_check
                                CHECK (status IN ('ACTIVE','INACTIVE')),
    assigned_collector_id   UUID            NULL
                                REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
    portal_enabled          BOOLEAN         NOT NULL DEFAULT FALSE,
    portal_password_hash    VARCHAR(255)    NULL,
    portal_is_temp_password BOOLEAN         NOT NULL DEFAULT TRUE,
    portal_failed_attempts  SMALLINT        NOT NULL DEFAULT 0
                                CONSTRAINT customers_portal_failed_attempts_check
                                CHECK (portal_failed_attempts >= 0),
    portal_locked_at        TIMESTAMPTZ     NULL,
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_customers_dni       ON customers(dni);
CREATE INDEX idx_customers_status    ON customers(status);
CREATE INDEX idx_customers_collector ON customers(assigned_collector_id);

-- ── 3. product_categories ────────────────────────────────────
CREATE TABLE public.product_categories (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(100) NOT NULL UNIQUE,
    active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 4. product_brands ────────────────────────────────────────
CREATE TABLE public.product_brands (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(100) NOT NULL UNIQUE,
    active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 5. products ──────────────────────────────────────────────
-- El stock disponible se obtiene como COUNT de product_units con status AVAILABLE.
-- El precio vive en product_variants, no en products.
CREATE TABLE public.products (
    id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    title       VARCHAR(150)    NOT NULL UNIQUE,
    description TEXT            NULL,
    model       VARCHAR(100)    NULL,
    brand_id    UUID            NULL REFERENCES product_brands(id) ON UPDATE CASCADE,
    category_id UUID            NULL REFERENCES product_categories(id) ON UPDATE CASCADE,
    status      VARCHAR(20)     NOT NULL DEFAULT 'ACTIVE'
                    CONSTRAINT products_status_check CHECK (status IN ('ACTIVE','INACTIVE')),
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_products_status   ON products(status);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_brand    ON products(brand_id);

-- ── 6. product_variants ──────────────────────────────────────
-- Cada variante es una combinación de atributos con su propio precio.
-- Un producto debe tener al menos una variante para poder venderse.
CREATE TABLE public.product_variants (
    id            UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id    UUID            NOT NULL REFERENCES products(id) ON UPDATE CASCADE,
    color         VARCHAR(50)     NULL,
    size          VARCHAR(50)     NULL,
    capacity      VARCHAR(50)     NULL,
    current_price NUMERIC(12,2)   NOT NULL
                      CONSTRAINT product_variants_current_price_check CHECK (current_price > 0),
    status        VARCHAR(15)     NOT NULL DEFAULT 'ACTIVE'
                      CONSTRAINT product_variants_status_check CHECK (status IN ('ACTIVE','INACTIVE')),
    created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_product_variants_product ON product_variants(product_id);
CREATE INDEX idx_product_variants_status  ON product_variants(status);

-- ── 7. product_units ─────────────────────────────────────────
-- Cada fila representa una unidad física individual con código único.
-- Referencia a la variante (que a su vez referencia el producto).
-- status: AVAILABLE → libre; RESERVED → en crédito pendiente de aprobación;
--         SOLD → en crédito activo/liquidado; INACTIVE → dada de baja.
CREATE TABLE public.product_units (
    id         UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id UUID            NOT NULL REFERENCES product_variants(id) ON UPDATE CASCADE,
    unit_code  VARCHAR(100)    NOT NULL,
    status     VARCHAR(15)     NOT NULL DEFAULT 'AVAILABLE'
                   CONSTRAINT product_units_status_check
                   CHECK (status IN ('AVAILABLE','RESERVED','SOLD','INACTIVE')),
    notes      TEXT            NULL,
    created_at TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT product_units_unit_code_unique UNIQUE (unit_code)
);
CREATE INDEX idx_product_units_variant ON product_units(variant_id);
CREATE INDEX idx_product_units_status  ON product_units(status);

-- ── 8. stock_movements ───────────────────────────────────────
-- Registra altas (IN) y bajas (OUT) manuales de unidades.
-- product_unit_id apunta a la unidad específica cuando aplica.
CREATE TABLE public.stock_movements (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      UUID        NOT NULL REFERENCES products(id) ON UPDATE CASCADE,
    product_unit_id UUID        NULL REFERENCES product_units(id) ON UPDATE CASCADE,
    movement        VARCHAR(3)  NOT NULL CHECK (movement IN ('IN','OUT')),
    quantity        INTEGER     NOT NULL CHECK (quantity > 0),
    reason          TEXT        NULL,
    user_id         UUID        NULL REFERENCES users(id) ON UPDATE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX idx_stock_movements_unit    ON stock_movements(product_unit_id);
CREATE INDEX idx_stock_movements_date    ON stock_movements(created_at);

-- ── 9. interest_rates ────────────────────────────────────────
-- Exclusivo para créditos tipo LOAN (préstamos en efectivo).
CREATE TABLE public.interest_rates (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    installments_count  SMALLINT        NOT NULL
                            CONSTRAINT interest_rates_installments_count_check CHECK (installments_count > 0),
    payment_frequency   VARCHAR(15)     NOT NULL
                            CONSTRAINT interest_rates_payment_frequency_check
                            CHECK (payment_frequency IN ('WEEKLY','BIWEEKLY','MONTHLY')),
    rate                NUMERIC(6,4)    NOT NULL
                            CONSTRAINT interest_rates_rate_check CHECK (rate > 0),
    active              BOOLEAN         NOT NULL DEFAULT TRUE,
    min_amount          NUMERIC(12,2)   NOT NULL,
    max_amount          NUMERIC(12,2)   NULL,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT interest_rates_unique_combination
        UNIQUE (payment_frequency, installments_count, min_amount, max_amount)
);
CREATE INDEX idx_interest_rates_freq   ON interest_rates(payment_frequency);
CREATE INDEX idx_interest_rates_active ON interest_rates(active);
CREATE INDEX idx_interest_rates_amount ON interest_rates(min_amount, max_amount);

-- ── 10. product_rates ─────────────────────────────────────────
-- Exclusivo para créditos tipo SALE (ventas de productos).
-- Aplica al producto padre, compartido por todas sus variantes.
CREATE TABLE public.product_rates (
    id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id         UUID            NOT NULL REFERENCES products(id) ON UPDATE CASCADE,
    payment_frequency  VARCHAR(15)     NOT NULL
                           CONSTRAINT product_rates_payment_frequency_check
                           CHECK (payment_frequency IN ('WEEKLY','BIWEEKLY','MONTHLY')),
    installments_count SMALLINT        NOT NULL
                           CONSTRAINT product_rates_installments_count_check
                           CHECK (installments_count > 0),
    rate               NUMERIC(6,4)    NOT NULL
                           CONSTRAINT product_rates_rate_check CHECK (rate > 0),
    active             BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT product_rates_unique
        UNIQUE (product_id, payment_frequency, installments_count)
);
CREATE INDEX idx_product_rates_product ON product_rates(product_id);
CREATE INDEX idx_product_rates_active  ON product_rates(active);

-- ── 11. credits ───────────────────────────────────────────────
CREATE TABLE public.credits (
    id                                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id                       UUID            NOT NULL REFERENCES customers(id) ON UPDATE CASCADE,
    created_by                        UUID            NULL REFERENCES users(id) ON UPDATE CASCADE,
    approved_by                       UUID            NULL REFERENCES users(id) ON UPDATE CASCADE,
    type                              VARCHAR(10)     NOT NULL
                                          CONSTRAINT credits_type_check CHECK (type IN ('SALE','LOAN')),
    total_amount                      NUMERIC(12,2)   NOT NULL
                                          CONSTRAINT credits_total_amount_check CHECK (total_amount > 0),
    down_payment                      NUMERIC(12,2)   NOT NULL DEFAULT 0
                                          CONSTRAINT credits_down_payment_check CHECK (down_payment >= 0),
    down_payment_method               VARCHAR(15)     NULL
                                          CONSTRAINT credits_down_payment_method_check
                                          CHECK (down_payment_method IN ('CASH','TRANSFER')),
    down_payment_transfer_reference   VARCHAR(100)    NULL,
    prepaid_installments              SMALLINT        NOT NULL DEFAULT 0
                                          CONSTRAINT credits_prepaid_installments_check CHECK (prepaid_installments >= 0),
    prepaid_installments_method       VARCHAR(15)     NULL
                                          CONSTRAINT credits_prepaid_installments_method_check
                                          CHECK (prepaid_installments_method IN ('CASH','TRANSFER')),
    prepaid_installments_transfer_reference VARCHAR(100) NULL,
    installments_count                SMALLINT        NOT NULL
                                          CONSTRAINT credits_installments_count_check CHECK (installments_count > 0),
    payment_frequency                 VARCHAR(15)     NOT NULL
                                          CONSTRAINT credits_payment_frequency_check
                                          CHECK (payment_frequency IN ('WEEKLY','BIWEEKLY','MONTHLY')),
    interest_rate                     NUMERIC(6,4)    NULL
                                          CONSTRAINT credits_interest_rate_check CHECK (interest_rate >= 0),
    status                            VARCHAR(25)     NOT NULL DEFAULT 'PENDING_APPROVAL'
                                          CONSTRAINT credits_status_check
                                          CHECK (status IN ('PENDING_APPROVAL','ACTIVE','SETTLED','REJECTED','EXPIRED')),
    rejection_reason                  TEXT            NULL,
    notes                             TEXT            NULL,
    approved_at                       TIMESTAMPTZ     NULL,
    settled_at                        TIMESTAMPTZ     NULL,
    settlement_amount                 NUMERIC(12,2)   NULL,
    settlement_type                   VARCHAR(25)     NULL
                                          CONSTRAINT credits_settlement_type_check
                                          CHECK (settlement_type IN ('NORMAL','EARLY_CANCELLATION')),
    created_at                        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at                        TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_credits_customer   ON credits(customer_id);
CREATE INDEX idx_credits_created_by ON credits(created_by);
CREATE INDEX idx_credits_status     ON credits(status);
CREATE INDEX idx_credits_type       ON credits(type);
CREATE INDEX idx_credits_frequency  ON credits(payment_frequency);
CREATE INDEX idx_credits_approved   ON credits(approved_at);

-- ── 12. credit_products ───────────────────────────────────────
-- Una fila por unidad física vendida. historical_rate se congela al aprobar.
CREATE TABLE public.credit_products (
    id               UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_id        UUID            NOT NULL REFERENCES credits(id) ON UPDATE CASCADE,
    product_unit_id  UUID            NOT NULL REFERENCES product_units(id) ON UPDATE CASCADE,
    historical_price NUMERIC(12,2)   NOT NULL
                         CONSTRAINT credit_products_historical_price_check CHECK (historical_price > 0),
    historical_rate  NUMERIC(6,4)    NULL
);
CREATE INDEX idx_credit_products_credit ON credit_products(credit_id);
CREATE INDEX idx_credit_products_unit   ON credit_products(product_unit_id);

-- ── 13. installments ─────────────────────────────────────────
CREATE TABLE public.installments (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_id           UUID            NOT NULL REFERENCES credits(id) ON UPDATE CASCADE,
    installment_number  SMALLINT        NOT NULL
                            CONSTRAINT installments_installment_number_check CHECK (installment_number > 0),
    due_date            DATE            NOT NULL,
    original_due_date   DATE            NULL,
    payment_frequency   VARCHAR(15)     NOT NULL
                            CONSTRAINT installments_payment_frequency_check
                            CHECK (payment_frequency IN ('WEEKLY','BIWEEKLY','MONTHLY')),
    original_amount     NUMERIC(12,2)   NOT NULL
                            CONSTRAINT installments_original_amount_check CHECK (original_amount > 0),
    penalty_amount      NUMERIC(12,2)   NOT NULL DEFAULT 0
                            CONSTRAINT installments_penalty_amount_check CHECK (penalty_amount >= 0),
    amount_due          NUMERIC(12,2)   NOT NULL
                            CONSTRAINT installments_amount_due_check CHECK (amount_due > 0),
    amount_paid         NUMERIC(12,2)   NOT NULL DEFAULT 0,
    status              VARCHAR(20)     NOT NULL DEFAULT 'PENDING'
                            CONSTRAINT installments_status_check
                            CHECK (status IN ('PENDING','PAID','PARTIAL','OVERDUE')),
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    UNIQUE (credit_id, installment_number)
);
CREATE INDEX idx_installments_credit   ON installments(credit_id);
CREATE INDEX idx_installments_status   ON installments(status);
CREATE INDEX idx_installments_due_date ON installments(due_date);

-- ── 14. payments ─────────────────────────────────────────────
CREATE TABLE public.payments (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    installment_id      UUID            NOT NULL REFERENCES installments(id) ON UPDATE CASCADE,
    collector_id        UUID            NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
    approved_by         UUID            NULL REFERENCES users(id) ON UPDATE CASCADE,
    amount_received     NUMERIC(12,2)   NOT NULL
                            CONSTRAINT payments_amount_received_check CHECK (amount_received > 0),
    payment_method      VARCHAR(15)     NOT NULL
                            CONSTRAINT payments_payment_method_check
                            CHECK (payment_method IN ('CASH','TRANSFER')),
    transfer_reference  VARCHAR(100)    NULL,
    status              VARCHAR(15)     NOT NULL DEFAULT 'PENDING'
                            CONSTRAINT payments_status_check
                            CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    rejection_reason    TEXT            NULL,
    notes               TEXT            NULL,
    approved_at         TIMESTAMPTZ     NULL,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_payments_installment ON payments(installment_id);
CREATE INDEX idx_payments_collector   ON payments(collector_id);
CREATE INDEX idx_payments_status      ON payments(status);
CREATE INDEX idx_payments_created     ON payments(created_at);

-- ── 15. credit_down_payments ─────────────────────────────────
CREATE TABLE public.credit_down_payments (
    id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_id          UUID            NOT NULL REFERENCES credits(id) ON UPDATE CASCADE,
    amount             NUMERIC(12,2)   NOT NULL
                           CONSTRAINT credit_down_payments_amount_check CHECK (amount > 0),
    payment_method     VARCHAR(15)     NOT NULL
                           CONSTRAINT credit_down_payments_payment_method_check
                           CHECK (payment_method IN ('CASH','TRANSFER')),
    transfer_reference VARCHAR(100)    NULL,
    approved_by        UUID            NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
    payment_type       VARCHAR(30)     NOT NULL DEFAULT 'DOWN_PAYMENT'
                           CONSTRAINT credit_down_payments_payment_type_check
                           CHECK (payment_type IN ('DOWN_PAYMENT','PREPAID_INSTALLMENT')),
    created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_credit_down_payments_credit ON credit_down_payments(credit_id);
CREATE INDEX idx_credit_down_payments_date   ON credit_down_payments(created_at);

-- ── 16. cash_registers ───────────────────────────────────────
CREATE TABLE public.cash_registers (
    id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    register_date     DATE            NOT NULL UNIQUE,
    total_collected   NUMERIC(12,2)   NOT NULL DEFAULT 0,
    cash_amount       NUMERIC(12,2)   NOT NULL DEFAULT 0,
    transfer_amount   NUMERIC(12,2)   NOT NULL DEFAULT 0,
    declared_cash     NUMERIC(12,2)   NOT NULL DEFAULT 0,
    difference        NUMERIC(12,2)   NOT NULL DEFAULT 0,
    total_egreses     NUMERIC(12,2)   NOT NULL DEFAULT 0,
    difference_status VARCHAR(15)     NOT NULL DEFAULT 'EXACT'
                          CONSTRAINT cash_registers_difference_status_check
                          CHECK (difference_status IN ('EXACT','SURPLUS','SHORTAGE')),
    observations      TEXT            NULL,
    closed_by         UUID            NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
    created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_cash_registers_date ON cash_registers(register_date);

-- ── 17. collection_sheets ────────────────────────────────────
CREATE TABLE public.collection_sheets (
    id           UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_date   DATE            NOT NULL,
    collector_id UUID            NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
    generated_by UUID            NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
    status       VARCHAR(15)     NOT NULL DEFAULT 'ACTIVE'
                     CONSTRAINT collection_sheets_status_check
                     CHECK (status IN ('ACTIVE','HISTORICAL')),
    filter_used  VARCHAR(20)     NOT NULL DEFAULT 'ALL_PENDING',
    created_at   TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    UNIQUE (sheet_date, collector_id)
);
CREATE INDEX idx_collection_sheets_date      ON collection_sheets(sheet_date);
CREATE INDEX idx_collection_sheets_collector ON collection_sheets(collector_id);

-- ── 18. collection_sheet_details ─────────────────────────────
CREATE TABLE public.collection_sheet_details (
    id             UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id       UUID            NOT NULL REFERENCES collection_sheets(id) ON UPDATE CASCADE,
    installment_id UUID            NOT NULL REFERENCES installments(id) ON UPDATE CASCADE,
    order_number   SMALLINT        NOT NULL
                       CONSTRAINT collection_sheet_details_order_number_check CHECK (order_number > 0),
    planned_amount NUMERIC(12,2)   NOT NULL
                       CONSTRAINT collection_sheet_details_planned_amount_check CHECK (planned_amount > 0)
);
CREATE INDEX idx_csd_sheet       ON collection_sheet_details(sheet_id);
CREATE INDEX idx_csd_installment ON collection_sheet_details(installment_id);

-- ── 19. token_blacklist ──────────────────────────────────────
CREATE TABLE public.token_blacklist (
    id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    token_jti   VARCHAR(255)    NOT NULL UNIQUE,
    user_id     UUID            NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    customer_id UUID            NULL REFERENCES customers(id) ON UPDATE CASCADE ON DELETE CASCADE,
    revoked_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ     NOT NULL,
    CONSTRAINT token_blacklist_owner_check
        CHECK (
            (user_id IS NOT NULL AND customer_id IS NULL) OR
            (user_id IS NULL     AND customer_id IS NOT NULL)
        )
);
CREATE INDEX idx_token_blacklist_jti     ON token_blacklist(token_jti);
CREATE INDEX idx_token_blacklist_expires ON token_blacklist(expires_at);

-- ── 20. salaries ─────────────────────────────────────────────
CREATE TABLE public.salaries (
    id            UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID            NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
    weekly_amount NUMERIC(12,2)   NOT NULL CHECK (weekly_amount > 0),
    active        BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_salaries_user   ON salaries(user_id);
CREATE INDEX idx_salaries_active ON salaries(active);

-- ── 21. commissions ──────────────────────────────────────────
CREATE TABLE public.commissions (
    id         UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID            NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
    credit_id  UUID            NOT NULL REFERENCES credits(id) ON UPDATE CASCADE,
    amount     NUMERIC(12,2)   NOT NULL,
    status     VARCHAR(15)     NOT NULL DEFAULT 'PENDING'
                   CONSTRAINT commissions_status_check
                   CHECK (status IN ('PENDING','PAID','REVERSED')),
    week_start DATE            NOT NULL,
    week_end   DATE            NOT NULL,
    created_at TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT commissions_check CHECK (week_end >= week_start)
);
CREATE INDEX idx_commissions_user   ON commissions(user_id);
CREATE INDEX idx_commissions_credit ON commissions(credit_id);
CREATE INDEX idx_commissions_status ON commissions(status);
CREATE INDEX idx_commissions_week   ON commissions(week_start, week_end);

-- ── 22. commission_liquidations ──────────────────────────────
CREATE TABLE public.commission_liquidations (
    id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID            NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
    paid_by            UUID            NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
    cash_register_id   UUID            NULL REFERENCES cash_registers(id) ON UPDATE CASCADE,
    week_start         DATE            NOT NULL,
    week_end           DATE            NOT NULL,
    commissions_total  NUMERIC(12,2)   NOT NULL DEFAULT 0,
    salary_amount      NUMERIC(12,2)   NOT NULL DEFAULT 0,
    total_paid         NUMERIC(12,2)   NOT NULL
                           CONSTRAINT commission_liquidations_total_paid_check CHECK (total_paid >= 0),
    payment_method     VARCHAR(15)     NOT NULL
                           CONSTRAINT commission_liquidations_payment_method_check
                           CHECK (payment_method IN ('CASH','TRANSFER')),
    transfer_reference VARCHAR(100)    NULL,
    paid_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT commission_liquidations_check CHECK (week_end >= week_start),
    UNIQUE (user_id, week_start)
);
CREATE INDEX idx_comm_liq_user ON commission_liquidations(user_id);
CREATE INDEX idx_comm_liq_week ON commission_liquidations(week_start);

-- ── 23. expense_categories ───────────────────────────────────
CREATE TABLE public.expense_categories (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(100) NOT NULL UNIQUE,
    active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 24. expenses ─────────────────────────────────────────────
CREATE TABLE public.expenses (
    id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    amount             NUMERIC(12,2)   NOT NULL
                           CONSTRAINT expenses_amount_check CHECK (amount > 0),
    description        TEXT            NOT NULL,
    expense_date       DATE            NOT NULL DEFAULT CURRENT_DATE,
    payment_method     VARCHAR(15)     NOT NULL
                           CONSTRAINT expenses_payment_method_check
                           CHECK (payment_method IN ('CASH','TRANSFER')),
    transfer_reference VARCHAR(100)    NULL,
    category_id        UUID            NULL REFERENCES expense_categories(id),
    created_by         UUID            NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
    created_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_expenses_date       ON expenses(expense_date);
CREATE INDEX idx_expenses_created_at ON expenses(created_at);
CREATE INDEX idx_expenses_created_by ON expenses(created_by);
CREATE INDEX idx_expenses_category   ON expenses(category_id);

-- ── 25. system_config ────────────────────────────────────────
CREATE TABLE public.system_config (
    key         VARCHAR(100)    PRIMARY KEY,
    value       VARCHAR(255)    NOT NULL,
    description TEXT            NULL,
    updated_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_by  UUID            NULL REFERENCES users(id) ON UPDATE CASCADE
);

-- ============================================================
--  DATOS INICIALES
-- ============================================================

INSERT INTO public.expense_categories (name) VALUES
    ('Alquiler'),
    ('Servicios'),
    ('Sueldos externos'),
    ('Insumos'),
    ('Otros')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.product_categories (name) VALUES
    -- Tecnología
    ('Celulares y Telefonía'),
    ('Computación e Informática'),
    ('Electrónica'),
    ('Electrodomésticos'),
    ('Audio y Video'),
    ('Climatización'),
    ('Gaming y Videojuegos'),
    ('Fotografía y Video'),
    -- Hogar
    ('Muebles y Decoración'),
    ('Colchones y Sommiers'),
    ('Cocina y Gastronomía'),
    ('Jardín y Exterior'),
    ('Iluminación'),
    ('Construcción y Materiales'),
    -- Ropa y Accesorios
    ('Ropa y Calzado'),
    ('Joyería y Relojes'),
    ('Bolsos y Carteras'),
    -- Deportes y Recreación
    ('Deportes y Fitness'),
    ('Bicicletas y Movilidad'),
    ('Juguetes y Juegos'),
    -- Bienestar y Salud
    ('Belleza y Cuidado Personal'),
    ('Salud y Farmacia'),
    ('Bebés y Niños'),
    -- Otros
    ('Mascotas'),
    ('Automotor y Motos'),
    ('Herramientas'),
    ('Instrumentos Musicales'),
    ('Libros y Útiles'),
    ('Otros')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
--  Ejecutar después: npm run seed
-- ============================================================
