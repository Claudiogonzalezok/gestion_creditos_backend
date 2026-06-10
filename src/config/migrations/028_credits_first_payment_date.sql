-- 028_credits_first_payment_date.sql
--
-- Persiste la fecha del primer pago elegida en el wizard de nueva
-- operacion. Hasta ahora el frontend la enviaba al endpoint de creacion
-- pero el backend la descartaba, y al aprobar el credito el calculo de
-- vencimientos arrancaba desde la fecha de aprobacion (`new Date()`)
-- ignorando la decision del usuario.
--
-- La columna es NULL por compatibilidad: para creditos viejos (sin
-- la fecha persistida) el service mantiene el comportamiento legacy
-- via getDueDatesFromFirstPayment(null, ...) que cae a "hoy +
-- frecuencia". Cero impacto en datos existentes.

ALTER TABLE credits
  ADD COLUMN IF NOT EXISTS first_payment_date DATE NULL;
