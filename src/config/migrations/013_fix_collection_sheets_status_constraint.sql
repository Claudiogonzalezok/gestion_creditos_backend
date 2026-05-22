-- =============================================================================
-- Migración: corrige el CHECK de collection_sheets.status para aceptar 'REGENERATED'.
-- En la creación original (001) el constraint solo permitía 'ACTIVE'/'HISTORICAL'.
-- La migración 011 intentó cambiarlo con ADD COLUMN IF NOT EXISTS, pero al
-- existir ya la columna el constraint no se actualizó: regenerar planillas
-- fallaba con violación del CHECK.
-- =============================================================================

-- Eliminar el constraint antiguo (no aplica IF EXISTS por nombre fijo).
ALTER TABLE collection_sheets
  DROP CONSTRAINT IF EXISTS collection_sheets_status_check;

-- Si quedó algún registro con el valor legacy 'HISTORICAL', lo migramos
-- a 'REGENERATED' (semánticamente equivalente: planilla reemplazada).
UPDATE collection_sheets
   SET status = 'REGENERATED'
 WHERE status = 'HISTORICAL';

-- Asegurar que el tipo soporte la cadena más larga (originalmente VARCHAR(15)).
ALTER TABLE collection_sheets
  ALTER COLUMN status TYPE VARCHAR(20);

-- Reagregar el constraint con los valores correctos.
ALTER TABLE collection_sheets
  ADD CONSTRAINT collection_sheets_status_check
  CHECK (status IN ('ACTIVE', 'REGENERATED'));
