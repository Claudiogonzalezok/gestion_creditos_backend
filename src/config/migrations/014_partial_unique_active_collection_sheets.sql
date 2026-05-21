-- =============================================================================
-- Migración: convierte la UNIQUE (sheet_date, collector_id) en un índice
-- parcial que solo aplica a planillas ACTIVE. Sin esto, al regenerar una
-- planilla la fila REGENERATED conserva el par (sheet_date, collector_id)
-- y bloquea la inserción de la nueva ACTIVE.
-- =============================================================================

-- Eliminar la UNIQUE original (creada en 001 como restricción "UNIQUE (...)").
ALTER TABLE collection_sheets
  DROP CONSTRAINT IF EXISTS collection_sheets_sheet_date_collector_id_key;

-- Índice parcial: solo una planilla ACTIVE por (collector_id, sheet_date).
-- Las REGENERATED conviven sin restricción para preservar historial.
CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_sheets_active_per_day
  ON collection_sheets (collector_id, sheet_date)
  WHERE status = 'ACTIVE';
