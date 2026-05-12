-- ── 007: Tabla cash_movements — trazabilidad contable de pagos ───────────────
-- Registra cada movimiento individual de caja vinculado a un pago aprobado.
-- Se genera dentro de la MISMA transacción que la aprobación del pago.
-- Si la transacción del pago hace rollback, este registro también revierte.
--
-- Relación con cash_registers:
--   cash_registers → un registro por DÍA (creado al cerrar la caja).
--   cash_movements → un registro por PAGO APROBADO (creado al aprobar).
--   La vinculación es por register_date (fecha), no por FK directa,
--   porque la caja puede no existir aún cuando se aprueba el primer pago del día.
--
-- Regla de negocio:
--   No se puede aprobar un pago si existe un cash_register para register_date
--   (la existencia del registro = caja cerrada ese día).
--   Esta validación ocurre en la capa de servicio, antes de insertar aquí.

CREATE TABLE IF NOT EXISTS public.cash_movements (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id      UUID            NOT NULL
                        REFERENCES payments(id) ON UPDATE CASCADE,
    amount          NUMERIC(12,2)   NOT NULL
                        CONSTRAINT cash_movements_amount_check CHECK (amount > 0),
    movement_type   VARCHAR(15)     NOT NULL
                        CONSTRAINT cash_movements_type_check
                        CHECK (movement_type IN ('PAYMENT', 'REVERSAL')),
    payment_method  VARCHAR(15)     NOT NULL
                        CONSTRAINT cash_movements_method_check
                        CHECK (payment_method IN ('CASH', 'TRANSFER')),
    register_date   DATE            NOT NULL,
    created_by      UUID            NOT NULL
                        REFERENCES users(id) ON UPDATE CASCADE,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ── Índices ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cash_movements_payment
  ON cash_movements(payment_id);

CREATE INDEX IF NOT EXISTS idx_cash_movements_date
  ON cash_movements(register_date);

CREATE INDEX IF NOT EXISTS idx_cash_movements_date_method
  ON cash_movements(register_date, payment_method);

-- ── Un payment solo puede tener un movimiento de caja (salvo reversión) ───────
-- La reversión genera un segundo movement con type='REVERSAL'.
-- El índice único previene dobles movimientos del mismo tipo para el mismo pago.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_movements_payment_type
  ON cash_movements(payment_id, movement_type);
