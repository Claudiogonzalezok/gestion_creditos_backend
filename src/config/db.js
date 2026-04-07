const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'gestion_creditos',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max:      parseInt(process.env.DB_MAX_CONNECTIONS || '10'),
  idleTimeoutMillis:    30000,
  connectionTimeoutMillis: 5000,
});

// Verificar conexión al iniciar
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌  Error al conectar con PostgreSQL:', err.message);
    process.exit(1);
  }
  release();
  console.log('✅  Conectado a PostgreSQL →', process.env.DB_NAME);
});

module.exports = pool;
