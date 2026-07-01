-- =============================================================================
-- Migración: Gestión Administrativa de Cuotas — visita programada por el admin.
--
-- Suma el tipo de gestión 'SCHEDULED_VISIT' a la entidad existente
-- collection_attempts (NO se crean tablas ni estructuras paralelas). El admin
-- registra una visita futura cuando el cliente se comunica previamente; la
-- lógica de planillas ya la incorpora vía next_visit_date (CTE_LATEST_NEXT_VISIT).
--
-- Dos CHECK deben extenderse:
--   1. collection_attempts.attempt_type — para poder persistir el nuevo tipo.
--   2. collection_sheet_details.antecedent_type — el snapshot de antecedente al
--      generar una planilla copia el attempt_type del último intento. Si una
--      visita admin queda como último antecedente de una cuota, createDetails
--      insertaría 'SCHEDULED_VISIT' en antecedent_type; sin extender este CHECK
--      la generación de planillas fallaría con violación de constraint.
--
-- Ambos constraints se crearon inline (migración 011) con nombre autogenerado
-- por Postgres (<tabla>_<columna>_check). Se dropean por ese nombre y se
-- reagregan con el valor nuevo.
-- =============================================================================

-- 1. collection_attempts.attempt_type
ALTER TABLE collection_attempts
  DROP CONSTRAINT IF EXISTS collection_attempts_attempt_type_check;

ALTER TABLE collection_attempts
  ADD CONSTRAINT collection_attempts_attempt_type_check
  CHECK (attempt_type IN ('NO_PAYMENT', 'NOT_FOUND', 'SCHEDULED_VISIT'));

-- 2. collection_sheet_details.antecedent_type
ALTER TABLE collection_sheet_details
  DROP CONSTRAINT IF EXISTS collection_sheet_details_antecedent_type_check;

ALTER TABLE collection_sheet_details
  ADD CONSTRAINT collection_sheet_details_antecedent_type_check
  CHECK (antecedent_type IN ('PARTIAL_PAYMENT', 'NO_PAYMENT', 'NOT_FOUND', 'SCHEDULED_VISIT'));
