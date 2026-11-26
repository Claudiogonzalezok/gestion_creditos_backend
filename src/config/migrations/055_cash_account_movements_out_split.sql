-- ── 055: desglose por medio en egresos de Caja General (issue #93) ─────────
--
-- Hasta 034 un movimiento OUT no podía declarar medio (amount_cash y
-- amount_transfer forzados a 0). Para exponer cash_balance / transfer_balance
-- y validar egresos por medio, un OUT ahora PUEDE declarar su desglose
-- (amount_cash + amount_transfer = amount).
--
-- Un OUT sin desglose (0/0) sigue siendo válido: es el formato legacy y el de
-- los flujos automáticos que no conocen el medio. El saldo por medio lo
-- imputa a efectivo (cash_balance = current_balance - transfer_balance).
--
-- Sin columnas cacheadas ni backfill: los saldos por medio se derivan de los
-- movimientos bajo el mismo lock FOR UPDATE de current_balance. Por eso NO se
-- agrega CHECK >= 0 por medio: los OUT legacy sin medio pueden dejar
-- cash_balance derivado negativo en datos históricos.
--
-- Idempotencia: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT.

ALTER TABLE public.cash_account_movements
    DROP CONSTRAINT IF EXISTS cash_account_movements_amount_split_check;

ALTER TABLE public.cash_account_movements
    ADD CONSTRAINT cash_account_movements_amount_split_check CHECK (
        (direction = 'IN' AND amount_cash + amount_transfer = amount)
        OR (
            direction = 'OUT'
            AND (
                (amount_cash = 0 AND amount_transfer = 0)
                OR amount_cash + amount_transfer = amount
            )
        )
    );
