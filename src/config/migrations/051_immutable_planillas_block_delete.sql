-- ── 051: Planillas inmutables — bloquear DELETE físico ──────────────────────
-- La 020 solo protegía BEFORE UPDATE: una planilla "inmutable" podía borrarse.
-- Esta migración correctiva agrega triggers BEFORE DELETE sobre
-- collection_sheets y collection_sheet_details. La baja es siempre lógica
-- (status CANCELLED/REGENERATED). TRUNCATE no dispara triggers por fila, por lo
-- que las limpiezas de bases de test siguen funcionando.
-- Idempotente: CREATE OR REPLACE + DROP TRIGGER IF EXISTS.

CREATE OR REPLACE FUNCTION forbid_planilla_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Las planillas son inmutables: no se permite borrar filas de % (usar baja lógica).', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_csd_forbid_delete ON collection_sheet_details;
CREATE TRIGGER trg_csd_forbid_delete
  BEFORE DELETE ON collection_sheet_details
  FOR EACH ROW
  EXECUTE FUNCTION forbid_planilla_delete();

DROP TRIGGER IF EXISTS trg_collection_sheet_forbid_delete ON collection_sheets;
CREATE TRIGGER trg_collection_sheet_forbid_delete
  BEFORE DELETE ON collection_sheets
  FOR EACH ROW
  EXECUTE FUNCTION forbid_planilla_delete();
