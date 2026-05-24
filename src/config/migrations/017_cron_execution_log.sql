-- Tabla de auditoría para ejecuciones de cron jobs.
-- Captura el inicio, fin, éxito/fallo y filas afectadas de cada corrida.
-- Permite detectar jobs caídos, lentos o con errores recurrentes sin tener
-- que recorrer logs textuales.

CREATE TABLE cron_execution_log (
  id            SERIAL PRIMARY KEY,
  job_name      VARCHAR(100) NOT NULL,
  started_at    TIMESTAMPTZ  NOT NULL,
  finished_at   TIMESTAMPTZ,
  success       BOOLEAN,
  affected_rows INT,
  error_message TEXT,
  metadata      JSONB
);

CREATE INDEX idx_cron_execution_log_job_started
  ON cron_execution_log (job_name, started_at DESC);
