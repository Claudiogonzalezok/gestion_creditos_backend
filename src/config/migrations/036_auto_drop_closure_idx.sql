-- ── 036: idempotencia del auto-fondeo a Caja General al cerrar caja ────────
-- Garantiza (a nivel DB) que un cierre/reconciliación de cash_session genere
-- como máximo UN movimiento DROP_IN hacia Caja General. Defensa dura
-- complementaria al check de findMovementByReference a nivel app.
CREATE UNIQUE INDEX IF NOT EXISTS cam_one_drop_in_per_closure_idx ON cash_account_movements(reference_id)
WHERE
    movement_type = 'DROP_IN'
    AND reference_type = 'CASH_SESSION_CLOSURE';