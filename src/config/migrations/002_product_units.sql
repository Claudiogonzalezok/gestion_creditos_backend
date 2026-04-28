-- ============================================================
--  MIGRACIÓN 002 — Unidades individuales de producto
--  Ejecutar sobre la base de datos local existente.
--
--  ATENCIÓN: limpia créditos SALE y sus datos relacionados
--  porque el modelo de credit_products cambió en forma incompatible
--  (product_id+quantity → product_unit_id). Los créditos LOAN
--  y el resto de los datos NO se tocan.
-- ============================================================

BEGIN;

-- ── 1. Eliminar datos incompatibles (solo SALE) ───────────────
-- Detalles de planillas que referencian cuotas de créditos SALE
DELETE FROM collection_sheet_details
WHERE installment_id IN (
  SELECT i.id FROM installments i
  JOIN credits c ON c.id = i.credit_id
  WHERE c.type = 'SALE'
);

-- Planillas de cobro que quedaron sin detalles (opcional, limpieza)
DELETE FROM collection_sheets
WHERE id NOT IN (SELECT DISTINCT sheet_id FROM collection_sheet_details);

-- Pagos vinculados a cuotas de créditos SALE
DELETE FROM payments
WHERE installment_id IN (
  SELECT i.id FROM installments i
  JOIN credits c ON c.id = i.credit_id
  WHERE c.type = 'SALE'
);

-- Cuotas de créditos SALE
DELETE FROM installments
WHERE credit_id IN (SELECT id FROM credits WHERE type = 'SALE');

-- Comisiones de créditos SALE
DELETE FROM commissions
WHERE credit_id IN (SELECT id FROM credits WHERE type = 'SALE');

-- Enganches de créditos SALE
DELETE FROM credit_down_payments
WHERE credit_id IN (SELECT id FROM credits WHERE type = 'SALE');

-- Ítems de créditos (la tabla completa, ya que cambia su estructura)
DELETE FROM credit_products;

-- Créditos SALE
DELETE FROM credits WHERE type = 'SALE';

-- ── 2. Limpiar stock_movements (referencia available_stock_after) ──
-- Solo los eliminamos si los hay; en dev es seguro truncar
TRUNCATE TABLE stock_movements;

-- ── 3. Alterar products: quitar available_stock ───────────────
ALTER TABLE public.products
  DROP COLUMN IF EXISTS available_stock;

-- ── 4. Crear tabla product_units ─────────────────────────────
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

-- ── 5. Alterar credit_products: nuevo modelo por unidad ──────
-- Quitar índices viejos
DROP INDEX IF EXISTS idx_credit_products_product;

-- Quitar columnas del modelo viejo
ALTER TABLE public.credit_products
  DROP COLUMN IF EXISTS product_id,
  DROP COLUMN IF EXISTS quantity;

-- Agregar columna nueva (nullable primero para no romper si hay filas vacías)
ALTER TABLE public.credit_products
  ADD COLUMN IF NOT EXISTS product_unit_id UUID
    REFERENCES product_units(id) ON UPDATE CASCADE;

-- Ahora que la tabla está vacía podemos poner NOT NULL
ALTER TABLE public.credit_products
  ALTER COLUMN product_unit_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_products_unit ON credit_products(product_unit_id);

-- ── 6. Alterar stock_movements: nuevo esquema ─────────────────
-- Quitar columna vieja
ALTER TABLE public.stock_movements
  DROP COLUMN IF EXISTS available_stock_after;

-- Agregar referencia a unidad individual (opcional, para bajas puntuales)
ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS product_unit_id UUID
    REFERENCES product_units(id) ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS idx_stock_movements_unit ON stock_movements(product_unit_id);

COMMIT;
