-- ============================================================
--  MIGRACIÓN 002 — Unidades individuales de producto
--  Ejecutar sobre la base de datos local existente.
--
--  LIMPIA: todos los datos de planillas de cobro y créditos SALE
--  (en ambos casos son datos de prueba en dev).
--  Los créditos LOAN y el resto de los datos NO se tocan.
-- ============================================================

-- Descartar cualquier transacción colgada de un intento anterior
ROLLBACK;

BEGIN;

-- ── 1. Planillas de cobro (todas, en dev son datos de prueba) ─
DELETE FROM collection_sheet_details;
DELETE FROM collection_sheets;

-- ── 2. Datos de créditos SALE ─────────────────────────────────
DELETE FROM payments
WHERE installment_id IN (
  SELECT i.id FROM installments i
  JOIN credits c ON c.id = i.credit_id
  WHERE c.type = 'SALE'
);

DELETE FROM installments
WHERE credit_id IN (SELECT id FROM credits WHERE type = 'SALE');

DELETE FROM commissions
WHERE credit_id IN (SELECT id FROM credits WHERE type = 'SALE');

DELETE FROM credit_down_payments
WHERE credit_id IN (SELECT id FROM credits WHERE type = 'SALE');

DELETE FROM credit_products;

DELETE FROM credits WHERE type = 'SALE';

-- ── 3. Vaciar stock_movements (compatible con nuevo esquema) ───
DELETE FROM stock_movements;

-- ── 4. Alterar products: quitar available_stock ───────────────
ALTER TABLE public.products
  DROP COLUMN IF EXISTS available_stock;

-- ── 5. Crear tabla product_units ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.product_units (
    id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id  UUID            NOT NULL REFERENCES products(id) ON UPDATE CASCADE,
    unit_code   VARCHAR(100)    NOT NULL,
    status      VARCHAR(15)     NOT NULL DEFAULT 'AVAILABLE'
                    CONSTRAINT product_units_status_check
                    CHECK (status IN ('AVAILABLE','RESERVED','SOLD','INACTIVE')),
    notes       TEXT            NULL,
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT product_units_unit_code_unique UNIQUE (unit_code)
);

CREATE INDEX IF NOT EXISTS idx_product_units_product ON product_units(product_id);
CREATE INDEX IF NOT EXISTS idx_product_units_status  ON product_units(status);

-- ── 6. Alterar credit_products: nuevo modelo por unidad ───────
DROP INDEX IF EXISTS idx_credit_products_product;

ALTER TABLE public.credit_products
  DROP COLUMN IF EXISTS product_id,
  DROP COLUMN IF EXISTS quantity;

ALTER TABLE public.credit_products
  ADD COLUMN IF NOT EXISTS product_unit_id UUID
    REFERENCES product_units(id) ON UPDATE CASCADE;

-- La tabla quedó vacía: podemos poner NOT NULL sin problema
ALTER TABLE public.credit_products
  ALTER COLUMN product_unit_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_products_unit ON credit_products(product_unit_id);

-- ── 7. Alterar stock_movements: nuevo esquema ─────────────────
ALTER TABLE public.stock_movements
  DROP COLUMN IF EXISTS available_stock_after;

ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS product_unit_id UUID
    REFERENCES product_units(id) ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS idx_stock_movements_unit ON stock_movements(product_unit_id);

COMMIT;
