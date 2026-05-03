-- Amplía users.address de VARCHAR(50) a VARCHAR(255)
-- para alinearlo con customers.address y los validadores de entrada.
ALTER TABLE users
  ALTER COLUMN address TYPE VARCHAR(255);
