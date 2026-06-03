-- ── 026: defensa en profundidad — saldo nunca negativo en cash_accounts ────
--
-- La regla de negocio "current_balance >= 0" se valida en el service
-- (cashAccounts.insertMovementWithBalance) antes de cada movimiento OUT con
-- 409 INSUFFICIENT_BALANCE. Esta migración agrega la misma regla a nivel DB
-- como red de contención: cualquier UPDATE directo a cash_accounts.current_balance
-- (scripts de mantenimiento, jobs de reparación, migraciones futuras) que
-- intente dejar saldo negativo será rechazado por PostgreSQL.
--
-- Auditoría CRIT-3: la regla universal vivía solo en JS. Si algún proceso
-- bypaseaba el service, podía romperse la invariante sin que la DB se quejara.

ALTER TABLE public.cash_accounts
    DROP CONSTRAINT IF EXISTS chk_cash_accounts_current_balance_nonneg;

ALTER TABLE public.cash_accounts
    ADD CONSTRAINT chk_cash_accounts_current_balance_nonneg
    CHECK (current_balance >= 0);
