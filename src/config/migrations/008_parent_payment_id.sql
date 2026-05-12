-- ── 008: Trazabilidad de sub-pagos generados por distribución ────────────────
-- Cuando un cobro cubre el saldo de la cuota principal y tiene excedente,
-- el sistema genera pagos automáticos para las cuotas siguientes mediante
-- markInstallmentAsPrepaid(). Esta columna vincula esos sub-pagos al cobro
-- original para permitir reversión total (todas las cuotas afectadas).
--
-- Sin este vínculo, revertir un pago con distribución requeriría lógica frágil
-- basada en timestamps o notas de texto.
--
-- Reversible: columna nullable, no afecta registros previos.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS parent_payment_id UUID NULL
      REFERENCES payments(id) ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS idx_payments_parent
  ON payments(parent_payment_id)
  WHERE parent_payment_id IS NOT NULL;
