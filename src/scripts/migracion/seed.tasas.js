/**
 * Seed de tasas para el go-live — todas las frecuencias, combos principales.
 *
 * El cliente pidió arrancar con tasas armadas por el equipo e irlas editando
 * después desde la UI de Configuración. Valores anclados en la curva del seed
 * histórico del negocio (src/seeds/03_interest_rates.seed.js: ~30% por mes de
 * plazo, sublineal a mayor plazo). SON VALORES INICIALES EDITABLES.
 *
 *   node src/scripts/migracion/seed.tasas.js              (dry-run)
 *   node src/scripts/migracion/seed.tasas.js --ejecutar   (inserta)
 *
 * Comportamiento:
 *  - interest_rates (préstamos): banda única de monto (0 → sin tope) por
 *    combo. Si el combo (frecuencia, cuotas) YA tiene alguna tasa cargada,
 *    se SALTEA completo (evita bandas solapadas → matching no determinístico,
 *    ver migración 010).
 *  - product_rates (ventas): mismos valores para TODOS los productos ACTIVOS.
 *    Si el (producto, frecuencia, cuotas) ya existe, se saltea (ON CONFLICT).
 *  - Una sola transacción; dry-run = mismo camino + ROLLBACK.
 */
require("dotenv").config();
const { Pool } = require("pg");

const EJECUTAR = process.argv.includes("--ejecutar");

// ── Curva de tasas (EDITABLE) ────────────────────────────────────────────────
// Anclada al seed histórico: WEEKLY 4≈0.30 · 8≈0.55 · 12≈0.90 · 16≈1.05.
// Extendida por plazo-equivalente en meses al resto de las frecuencias.
const CURVA = {
  DAILY: { 30: 0.3, 60: 0.55 },
  WEEKLY: { 4: 0.3, 8: 0.55, 12: 0.9, 16: 1.05, 20: 1.25, 24: 1.45, 30: 1.7 },
  BIWEEKLY: { 2: 0.3, 4: 0.55, 6: 0.9, 8: 1.05 },
  MONTHLY: { 1: 0.3, 2: 0.55, 3: 0.9, 4: 1.05, 6: 1.45, 9: 1.9, 12: 2.3 },
};

// Combos de venta financiada que se cargan por producto (subset de la curva).
const COMBOS_VENTA = {
  DAILY: [30, 60],
  WEEKLY: [8, 12, 16, 20, 24, 30],
  BIWEEKLY: [4, 8],
  MONTHLY: [3, 6, 9, 12],
};

const main = async () => {
  const pool = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "gestion_creditos",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
  });
  const client = await pool.connect();
  console.log(`\n${EJECUTAR ? "🔥 CARGA REAL" : "🧪 DRY-RUN (rollback al final)"} → BD ${process.env.DB_NAME || "gestion_creditos"}@${process.env.DB_HOST || "localhost"}\n`);

  try {
    await client.query("BEGIN");

    // ── 1. interest_rates (préstamos) ────────────────────────────────────
    let prestamosInsertadas = 0;
    const prestamosSalteados = [];
    for (const [freq, cuotasMap] of Object.entries(CURVA)) {
      for (const [cuotas, tasa] of Object.entries(cuotasMap)) {
        const existente = await client.query(
          `SELECT 1 FROM interest_rates
           WHERE payment_frequency = $1 AND installments_count = $2 AND active = TRUE
           LIMIT 1`,
          [freq, cuotas],
        );
        if (existente.rows.length) {
          prestamosSalteados.push(`${freq} x${cuotas}`);
          continue;
        }
        await client.query(
          `INSERT INTO interest_rates
             (payment_frequency, installments_count, min_amount, max_amount, rate, active)
           VALUES ($1, $2, 0, NULL, $3, TRUE)`,
          [freq, cuotas, tasa],
        );
        prestamosInsertadas++;
      }
    }

    // ── 2. product_rates (ventas) — todos los productos activos ──────────
    const productos = await client.query(
      `SELECT id, title FROM products WHERE status = 'ACTIVE' ORDER BY title`,
    );
    let ventasInsertadas = 0;
    for (const p of productos.rows) {
      for (const [freq, listaCuotas] of Object.entries(COMBOS_VENTA)) {
        for (const cuotas of listaCuotas) {
          const r = await client.query(
            `INSERT INTO product_rates
               (product_id, payment_frequency, installments_count, rate, active)
             VALUES ($1, $2, $3, $4, TRUE)
             ON CONFLICT (product_id, payment_frequency, installments_count) DO NOTHING`,
            [p.id, freq, cuotas, CURVA[freq][cuotas]],
          );
          ventasInsertadas += r.rowCount;
        }
      }
    }

    console.log("── Resultado ──");
    console.log(`   Tasas de préstamo insertadas : ${prestamosInsertadas}`);
    if (prestamosSalteados.length) {
      console.log(`   Combos salteados (ya tenían tasa): ${prestamosSalteados.join(", ")}`);
    }
    console.log(`   Tasas de producto insertadas : ${ventasInsertadas} (${productos.rows.length} productos activos)`);

    if (EJECUTAR) {
      await client.query("COMMIT");
      console.log("\n✅ TASAS CARGADAS (COMMIT). Editar valores desde Configuración → Tasas.\n");
    } else {
      await client.query("ROLLBACK");
      console.log("\n🧪 Dry-run OK (ROLLBACK). Correr con --ejecutar para insertar.\n");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`\n❌ ABORTADO (rollback): ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

main();
