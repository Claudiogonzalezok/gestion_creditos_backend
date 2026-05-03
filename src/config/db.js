const { Pool, types } = require('pg');

// Evita que el driver convierta columnas DATE a objetos Date de JS.
// Sin esto, "2026-06-14" llega al cliente como "2026-06-14T03:00:00.000Z" (offset UTC-3).
types.setTypeParser(1082, (val) => val); // 1082 = OID del tipo DATE en PostgreSQL

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

// Fijar zona horaria ART en cada conexión para que los ::date casts sean correctos.
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'America/Argentina/Buenos_Aires'");
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
