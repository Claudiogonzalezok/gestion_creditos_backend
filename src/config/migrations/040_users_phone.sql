-- Agrega teléfono de contacto opcional para usuarios internos.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS phone VARCHAR(30) NULL;
