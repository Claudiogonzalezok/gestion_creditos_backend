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

const run = async () => {
  const sqlPath = path.join(__dirname, '../config/migrations/001_create_tables.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  🗄️   MIGRACIÓN — Sistema Gestión Créditos  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  Ejecutando: config/migrations/001_create_tables.sql');
  console.log('');

  try {
    await pool.query(sql);
    console.log('  ✅  Migración ejecutada correctamente.');
    console.log('');
    console.log('  Próximo paso: npm run seed');
    console.log('');
  } catch (err) {
    if (err.message.includes('already exists')) {
      console.log('  ⚠️   Las tablas ya existen.');
      console.log('       Si querés recrear desde cero:');
      console.log('       1. DROP DATABASE gestion_creditos;');
      console.log('       2. CREATE DATABASE gestion_creditos;');
      console.log('       3. npm run migration:run');
    } else {
      console.error('  ❌  Error en la migración:', err.message);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
};

run();
