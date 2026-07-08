-- =============================================================================
-- Migración: snapshots de inclusión/orden/remanente en collection_sheet_details.
--
-- Persistimos al momento de generación 3 valores que la planilla impresa debe
-- mantener inmutables aunque después cambien visitas o pagos:
--
--   inclusion_reason       — por qué entró la cuota (OVERDUE, DUE_TODAY,
--                            OVERDUE_UNSCHEDULED, SCHEDULED_VISIT, ALL_PENDING)
--   op_priority            — prioridad operativa para el orden de render
--                            (1 visita pactada · 2 mora · 3 vence hoy · 4 resto)
--   remaining_amount_snapshot — (amount_due - amount_paid) al generar; lo que
--                               realmente quedaba por cobrar en ese momento.
--                               Para cuotas PARTIAL diverge de planned_amount.
--
-- Mientras tanto next_visit_date y los datos de antecedente siguen
-- recalculándose dinámicamente en findById porque el cobrador necesita ver la
-- gestión más reciente. La diferencia entre snapshot e info viva está
-- documentada en collections.queries.js.
-- =============================================================================

ALTER TABLE collection_sheet_details
  ADD COLUMN IF NOT EXISTS inclusion_reason         VARCHAR(25),
  ADD COLUMN IF NOT EXISTS op_priority              SMALLINT,
  ADD COLUMN IF NOT EXISTS remaining_amount_snapshot NUMERIC(12,2);

CREATE INDEX IF NOT EXISTS idx_csd_inclusion_reason
  ON collection_sheet_details(inclusion_reason);
