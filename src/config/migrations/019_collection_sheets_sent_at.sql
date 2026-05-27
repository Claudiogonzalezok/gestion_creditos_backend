-- Agrega soporte para marcar planillas de cobro como enviadas al cobrador.
ALTER TABLE collection_sheets
  ADD COLUMN IF NOT EXISTS sent_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_by  UUID REFERENCES users(id);
