-- ── 010: Elimina filas de interest_rates con rangos solapados ─────────────────
-- Las filas 0–50.000 de BIWEEKLY 2, BIWEEKLY 4 y WEEKLY 8 quedaron duplicadas
-- porque ya existían filas 0–100.000 para las mismas combinaciones.
-- Cualquier monto entre 0 y 50.000 matcheaba las dos filas → resultado no determinístico.
-- Se elimina la fila de menor rango (0–50.000) conservando la de mayor cobertura (0–100.000).

DELETE FROM interest_rates
WHERE (payment_frequency, installments_count, min_amount::int, max_amount::int) IN (
    ('BIWEEKLY', 2, 0, 50000),
    ('BIWEEKLY', 4, 0, 50000),
    ('WEEKLY',   8, 0, 50000)
);
