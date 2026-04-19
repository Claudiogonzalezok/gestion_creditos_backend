require('dotenv').config();
const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'gestion_creditos',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

const MIGRATIONS_DIR = path.join(__dirname, '../config/migrations');

const run = async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  🗄️   MIGRACIÓN — Sistema Gestión Créditos  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // Leer y ordenar todos los archivos .sql de la carpeta de migraciones
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (!files.length) {
    console.log('  ⚠️   No se encontraron archivos de migración.');
    await pool.end();
    return;
  }

  // Verificar si ya existe tabla de control de migraciones
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
      await client.query(
        `INSERT INTO _migrations (filename) VALUES ($1)`, [file]
      );
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
  if (ran === 0) {
    console.log('  ✔️   La base de datos ya está actualizada.');
  } else {
    console.log(`  🎉  ${ran} migración(es) aplicada(s).`);
    console.log('');
    console.log('  Próximo paso: npm run seed');
  }
  console.log('');

  await pool.end();
};

run();
