-- =============================================================================
-- Migración 045 — Frecuencia de pago DAILY (Diaria)
--
-- Amplía el CHECK de `payment_frequency` para incluir 'DAILY' en las 4 tablas
-- que lo restringen: interest_rates, product_rates, credits, installments.
--
-- DAILY se integra como una frecuencia más del modelo de cuotas existente
-- (no crea flujo ni tipo de crédito nuevo). Vence en días corridos (la regla
-- de día hábil NO se aplica a DAILY; eso se resuelve en la capa de cálculo).
--
-- Sin backfill ni pérdida de datos: solo relaja el dominio permitido. Se
-- dropea dinámicamente cualquier CHECK previo sobre payment_frequency (cubre
-- tanto los constraints con nombre de la migración 001 como uno autogenerado
-- que algún entorno pudiera tener por el CREATE TABLE de la 002).
-- =============================================================================

DO $$
DECLARE
    v_table   TEXT;
    v_conname TEXT;
BEGIN
    FOREACH v_table IN ARRAY ARRAY['interest_rates', 'product_rates', 'credits', 'installments']
    LOOP
        -- Dropear cualquier CHECK constraint que restrinja payment_frequency en la tabla.
        FOR v_conname IN
            SELECT con.conname
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
            WHERE con.contype = 'c'
              AND nsp.nspname = 'public'
              AND rel.relname = v_table
              AND pg_get_constraintdef(con.oid) ILIKE '%payment_frequency%'
        LOOP
            EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_table, v_conname);
        END LOOP;

        -- Re-crear el CHECK con el nombre canónico incluyendo 'DAILY'.
        EXECUTE format(
            'ALTER TABLE public.%I ADD CONSTRAINT %I '
            || 'CHECK (payment_frequency IN (''WEEKLY'', ''BIWEEKLY'', ''MONTHLY'', ''DAILY''))',
            v_table,
            v_table || '_payment_frequency_check'
        );
    END LOOP;
END $$;
