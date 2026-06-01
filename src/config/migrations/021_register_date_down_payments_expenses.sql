-- CA-04: register_date en credit_down_payments para jornada comercial correcta
ALTER TABLE credit_down_payments ADD COLUMN register_date DATE;
UPDATE credit_down_payments SET register_date = created_at::date WHERE register_date IS NULL;
ALTER TABLE credit_down_payments ALTER COLUMN register_date SET NOT NULL;

-- CA-05: register_date en expenses para jornada comercial correcta
ALTER TABLE expenses ADD COLUMN register_date DATE;
UPDATE expenses SET register_date = created_at::date WHERE register_date IS NULL;
ALTER TABLE expenses ALTER COLUMN register_date SET NOT NULL;
