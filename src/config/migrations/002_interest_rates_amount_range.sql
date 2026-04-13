-- Migración 002: Agregar rangos de monto a la tabla interest_rates
-- Ejecutar una sola vez sobre la base de datos existente.
-- Fecha: 2026-04-12

-- 1. Agregar las columnas de rango de monto
ALTER TABLE interest_rates
  ADD COLUMN IF NOT EXISTS min_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_amount NUMERIC(12,2) DEFAULT NULL;

-- 2. Quitar el default temporal de min_amount (ya no es necesario después de la migración)
ALTER TABLE interest_rates
  ALTER COLUMN min_amount DROP DEFAULT;

-- 3. Eliminar la restricción de unicidad anterior (solo por combinación sin monto)
--    Nota: el nombre puede variar según cómo fue creada la tabla.
--    Ejecutar el siguiente SELECT para confirmar el nombre real antes de hacer el DROP:
--      SELECT conname FROM pg_constraint WHERE conrelid = 'interest_rates'::regclass AND contype = 'u';
ALTER TABLE interest_rates
  DROP CONSTRAINT IF EXISTS interest_rates_credit_type_payment_frequency_installments_key;

-- 4. Agregar nueva restricción de unicidad que incluye el rango de monto
--    (La validación de solapamiento se maneja en la capa de servicio)
ALTER TABLE interest_rates
  ADD CONSTRAINT interest_rates_unique_combination
  UNIQUE (credit_type, payment_frequency, installments_count, min_amount, max_amount);

-- Resultado esperado:
-- Cada fila de interest_rates representa ahora una tasa válida para una combinación
-- específica de tipo, frecuencia, cantidad de cuotas Y rango de monto del crédito.
--
-- Ejemplo de carga inicial (ajustar valores según lo que defina el Admin):
--
-- INSERT INTO interest_rates (credit_type, payment_frequency, installments_count, min_amount, max_amount, rate)
-- VALUES
--   ('LOAN', 'MONTHLY', 3,  0,      100000, 0.50),
--   ('LOAN', 'MONTHLY', 3,  100001, 300000, 0.45),
--   ('LOAN', 'MONTHLY', 3,  300001, NULL,   0.40),
--   ('LOAN', 'MONTHLY', 6,  0,      100000, 0.80),
--   ('LOAN', 'MONTHLY', 6,  100001, 300000, 0.75),
--   ('LOAN', 'MONTHLY', 6,  300001, NULL,   0.70),
--   ('SALE', 'MONTHLY', 3,  0,      100000, 0.55),
--   ('SALE', 'MONTHLY', 6,  0,      100000, 0.85);
