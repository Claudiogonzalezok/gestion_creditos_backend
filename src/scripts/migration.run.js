require('dotenv').config();
const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

const DB_NAME        = process.env.DB_NAME || 'gestion_creditos';
const MIGRATIONS_DIR = path.join(__dirname, '../config/migrations');

// Clave arbitraria y fija del advisory lock de migraciones.
const MIGRATION_LOCK_KEY = 52052;

// Prefijos repetidos ya aplicados en producción (001-049). No se renumeran:
// _migrations los identifica por nombre completo y el orden es alfabético.
const LEGACY_DUPLICATE_PREFIXES = new Set(['002', '006', '007', '033', '037']);

/**
 * Devuelve los prefijos numéricos repetidos que no están en la lista legacy.
 * @param {string[]} files - nombres de archivo .sql
 * @returns {string[]} prefijos repetidos no permitidos
 */
const findNewDuplicatePrefixes = (files) => {
  const counts = new Map();
  for (const file of files) {
    const prefix = file.split('_')[0];
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  return [...counts]
    .filter(([prefix, n]) => n > 1 && !LEGACY_DUPLICATE_PREFIXES.has(prefix))
    .map(([prefix]) => prefix);
};

const run = async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  🗄️   MIGRACIÓN — Sistema Gestión Créditos    ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  // ── Paso 1: crear la base si no existe (sin tocar datos existentes) ───────
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

    if (rows.length === 0) {
      console.log(`  ▶️   Creando base de datos "${DB_NAME}"...`);
      await adminPool.query(`CREATE DATABASE "${DB_NAME}"`);
      console.log(`  ✅  Base de datos "${DB_NAME}" creada correctamente.`);
      console.log('');
    } else {
      console.log(`  ✔️   Base de datos "${DB_NAME}" encontrada.`);
      console.log('');
    }
  } catch (err) {
    console.error('  ❌  Error al verificar la base de datos:', err.message);
    process.exit(1);
  } finally {
    await adminPool.end();
  }

  // ── Paso 2: conectar a la base y aplicar solo las migraciones pendientes ──
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

  // Numeración única (issue #52). Los prefijos repetidos históricos ya están
  // aplicados en producción y se identifican por nombre completo en
  // _migrations: no se renumeran. Cualquier prefijo repetido nuevo aborta.
  const duplicated = findNewDuplicatePrefixes(files);
  if (duplicated.length) {
    console.error(`  ❌  Prefijos de migración repetidos: ${duplicated.join(', ')}. Usar el próximo número libre.`);
    await pool.end();
    process.exit(1);
  }

  // Lock de sesión: dos procesos de migración concurrentes no aplican el mismo archivo.
  const lockClient = await pool.connect();
  await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = new Set(
    (await pool.query('SELECT filename FROM _migrations')).rows.map(r => r.filename)
  );

  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  ⏭️   ${file} — ya aplicada, omitida.`);
      continue;
    }

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
      lockClient.release(true);
      await pool.end();
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log('');
  if (ran === 0) {
    console.log('  ✔️   La base de datos ya está actualizada. No hay migraciones nuevas.');
  } else {
    console.log(`  🎉  ${ran} migración(es) aplicada(s).`);
    console.log('');
    console.log('  Próximo paso: npm run seed');
  }
  console.log('');

  await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  lockClient.release();
  await pool.end();
};

if (require.main === module) {
  run();
}

module.exports = { findNewDuplicatePrefixes, LEGACY_DUPLICATE_PREFIXES };
