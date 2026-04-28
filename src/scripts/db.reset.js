require('dotenv').config();
const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

const DB_NAME        = process.env.DB_NAME || 'gestion_creditos';
const MIGRATIONS_DIR = path.join(__dirname, '../config/migrations');

const run = async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  🔴  RESET — Sistema Gestión Créditos                 ║');
  console.log('║      ⚠️  ESTO ELIMINA TODOS LOS DATOS EXISTENTES      ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  // ── Paso 1: conectar a "postgres" para poder operar sobre la base target ──
  const adminPool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: 'postgres',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
  });

  try {
    const { rows } = await adminPool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`, [DB_NAME]
    );

    if (rows.length > 0) {
      console.log(`  ⚠️   La base de datos "${DB_NAME}" existe y será eliminada.`);
      console.log(`  🔌  Cerrando conexiones activas...`);

      // Terminar todas las conexiones abiertas antes de dropear
      await adminPool.query(`
        SELECT pg_terminate_backend(pid)
        FROM   pg_stat_activity
        WHERE  datname = $1
          AND  pid <> pg_backend_pid()
      `, [DB_NAME]);

      await adminPool.query(`DROP DATABASE "${DB_NAME}"`);
      console.log(`  🗑️   Base de datos eliminada.`);
      console.log('');
    }

    console.log(`  ▶️   Creando base de datos "${DB_NAME}"...`);
    await adminPool.query(`CREATE DATABASE "${DB_NAME}"`);
    console.log(`  ✅  Base de datos "${DB_NAME}" creada correctamente.`);
    console.log('');
  } catch (err) {
    console.error('  ❌  Error al preparar la base de datos:', err.message);
    process.exit(1);
  } finally {
    await adminPool.end();
  }

  // ── Paso 2: conectar a la nueva base y ejecutar migraciones ───────────────
  const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: DB_NAME,
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
  });

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (!files.length) {
    console.log('  ⚠️   No se encontraron archivos de migración.');
    await pool.end();
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  let ran = 0;

  for (const file of files) {
    console.log(`  ▶️   Ejecutando: ${file}`);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO _migrations (filename) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      console.log(`  ✅  ${file} aplicada correctamente.`);
      ran++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ❌  Error en ${file}:`, err.message);
      await pool.end();
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log('');
  console.log(`  🎉  Reset completado. ${ran} migración(es) aplicada(s).`);
  console.log('');

  await pool.end();
};

run();
