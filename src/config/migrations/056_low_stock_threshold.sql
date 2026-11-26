-- 056 · Umbral de stock bajo configurable (issue #106).
-- low_stock_threshold en system_config (default 5): lo usa GET /reports/products
-- cuando no llega stock_threshold y se expone en GET/PUT /api/company.
-- Aditiva e idempotente.

INSERT INTO system_config (key, value, description) VALUES
  ('low_stock_threshold', '5', 'Umbral de stock bajo: un producto con unidades disponibles <= este valor se marca como stock bajo')
ON CONFLICT (key) DO NOTHING;

-- ── DOWN ────────────────────────────────────────────────────────────────────
-- DELETE FROM system_config WHERE key = 'low_stock_threshold';
