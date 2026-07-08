-- ── 030: Pago mixto — efectivo + transferencia en un mismo cobro ─────────────
-- Permite que un payment se componga de un monto en efectivo y otro en
-- transferencia dentro de la misma operación de cobro.
--
-- PRINCIPIO DE DISEÑO: `amount_received` se mantiene como el TOTAL del cobro
-- (= amount_cash + amount_transfer). Toda la lógica financiera (distribución de
-- cuotas, saldos pendientes, validaciones de monto) sigue operando sobre ese
-- total sin cambios. El desglose por medio solo se usa al imputar movimientos
-- en caja: un movimiento por cada medio con monto > 0.
--
-- ORDEN DE MIGRACIONES: el CHECK de consistencia
-- (amount_cash + amount_transfer = amount_received) NO se agrega aquí porque los
-- INSERT actuales todavía no llenan las columnas nuevas. Ese constraint entra en
-- la migración 031, apareado con la actualización de las queries de payments.
--
-- Reversible: las columnas nuevas pueden dropearse; el backfill reconstruye el
-- desglose a partir de payment_method para los registros existentes.

-- ── Columnas de desglose por medio ───────────────────────────────────────────
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS amount_cash     NUMERIC(12,2) NOT NULL DEFAULT 0
      CONSTRAINT payments_amount_cash_check     CHECK (amount_cash >= 0),
  ADD COLUMN IF NOT EXISTS amount_transfer NUMERIC(12,2) NOT NULL DEFAULT 0
      CONSTRAINT payments_amount_transfer_check CHECK (amount_transfer >= 0);

-- ── Backfill: reconstruir el desglose desde payment_method ───────────────────
-- Cada registro existente tiene un único medio, así que todo su monto recibido
-- se imputa a la columna correspondiente. El guard (ambas columnas en 0) hace
-- la migración idempotente: una re-ejecución no vuelve a escribir.
UPDATE payments
   SET amount_cash     = amount_received,
       amount_transfer = 0
 WHERE payment_method = 'CASH'
   AND amount_cash = 0
   AND amount_transfer = 0;

UPDATE payments
   SET amount_transfer = amount_received,
       amount_cash     = 0
 WHERE payment_method = 'TRANSFER'
   AND amount_cash = 0
   AND amount_transfer = 0;

-- ── payment_method: habilitar 'MIXED' para cobros con ambos medios ───────────
-- Se usa cuando amount_cash > 0 y amount_transfer > 0. Ningún registro toma
-- este valor todavía; lo escribirán las queries actualizadas (migración 031).
ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_payment_method_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_payment_method_check
    CHECK (payment_method IN ('CASH','TRANSFER','MIXED'));
