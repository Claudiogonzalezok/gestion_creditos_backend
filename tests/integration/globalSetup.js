// Global setup ejecutado UNA SOLA VEZ antes de toda la suite de integration.
//   1. Carga .env.test (lo dejamos disponible para el resto del proceso).
//   2. Verifica que la DB de test responde.
//   3. Aplica todas las migraciones reales (idempotentes vía _migrations).
//   4. Inserta seed mínimo de system_config (necesario para getValue).
//
// No crea fixtures de negocio (customers, credits, etc.) — eso queda a cargo
// de los helpers de fixtures, llamados explícitamente desde cada test.

const path = require('path');
const fs   = require('fs');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '../../.env.test') });

const MIGRATIONS_DIR = path.join(__dirname, '../../src/config/migrations');

module.exports = async () => {
  console.log('\n[integration:setup] Configurando DB de test...');

  const pool = new Pool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    // 1. Ping rápido para verificar que el contenedor esté arriba
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(
      `No se pudo conectar a la DB de test (${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}).\n` +
      `¿Está corriendo el contenedor? Ejecutá: npm run test:db:up\n` +
      `Detalle: ${err.message}`
    );
  }

  // 2. Aplicar migraciones (idempotente)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const applied = new Set(
    (await pool.query('SELECT filename FROM _migrations')).rows.map((r) => r.filename)
  );

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO _migrations (filename) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      ran++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Falló migración ${file}: ${err.message}`);
    } finally {
      client.release();
    }
  }
  console.log(`[integration:setup] Migraciones aplicadas: ${ran} nuevas (total ${files.length}).`);

  // 3. Seed mínimo de system_config con los defaults del módulo de configuración
  const { DEFAULT_VALUES } = require('../../src/modules/systemConfig/systemConfig.queries');
  for (const [key, def] of Object.entries(DEFAULT_VALUES)) {
    await pool.query(
      `INSERT INTO system_config (key, value, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, def.value, def.description]
    );
  }
  console.log(`[integration:setup] Seed system_config: ${Object.keys(DEFAULT_VALUES).length} claves.`);

  await pool.end();
  console.log('[integration:setup] OK.\n');
};
