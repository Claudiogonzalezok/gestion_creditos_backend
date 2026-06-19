-- ── 038: nuevo movement_type MANUAL_INCOME en cash_account_movements ──────
--
-- Permite registrar un "Ingreso Manual" directo a Caja General (tesorería),
-- sin pasar por una cash_session — análogo al manual_income que ya existe
-- en el modelo de caja operativa (cash_sessions), pero para tesorería.
-- Dirección fija IN (no es bidireccional como ADJUSTMENT): un ingreso manual
-- nunca resta saldo.
--
-- Idempotencia: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT. Re-ejecutar la
-- migración no rompe el estado convergente.

ALTER TABLE public.cash_account_movements
    DROP CONSTRAINT IF EXISTS cash_account_movements_type_check;

ALTER TABLE public.cash_account_movements
    ADD CONSTRAINT cash_account_movements_type_check
    CHECK (movement_type IN (
        'DROP_IN','SUPPLIER_PAYMENT','SALARY_PAYMENT',
        'EXPENSE','ADJUSTMENT','MANUAL_INCOME'
    ));

ALTER TABLE public.cash_account_movements
    DROP CONSTRAINT IF EXISTS cash_account_movements_type_direction_check;

ALTER TABLE public.cash_account_movements
    ADD CONSTRAINT cash_account_movements_type_direction_check
    CHECK (
        (movement_type = 'DROP_IN'          AND direction = 'IN')  OR
        (movement_type = 'SUPPLIER_PAYMENT' AND direction = 'OUT') OR
        (movement_type = 'SALARY_PAYMENT'   AND direction = 'OUT') OR
        (movement_type = 'EXPENSE'          AND direction = 'OUT') OR
        (movement_type = 'MANUAL_INCOME'    AND direction = 'IN')  OR
        (movement_type = 'ADJUSTMENT'       AND direction IN ('IN','OUT'))
    );
