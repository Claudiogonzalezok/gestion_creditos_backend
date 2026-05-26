-- Agrega el estado REFINANCED al CHECK constraint de installments.status.
-- Las cuotas pendientes/vencidas de un crédito refinanciado se marcan con
-- este estado para excluirlas de jobs de mora, planillas y reportes sin
-- depender de joins a la tabla credits.

ALTER TABLE installments
  DROP CONSTRAINT installments_status_check,
  ADD CONSTRAINT installments_status_check
    CHECK (status IN ('PENDING','PAID','PARTIAL','OVERDUE','REFINANCED'));
