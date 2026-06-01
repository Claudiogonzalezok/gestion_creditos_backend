require('dotenv').config();

const { Pool, types } = require('pg');

// Evita que el driver convierta columnas DATE a objetos Date de JS.
// Sin esto, "2026-06-14" llega al cliente como "2026-06-14T03:00:00.000Z" (offset UTC-3).
types.setTypeParser(1082, (val) => val); // 1082 = OID del tipo DATE en PostgreSQL

// La zona horaria se fija en el handshake de conexión (-c TimeZone=...) en lugar
// de en un hook pool.on('connect') con SET TIME ZONE sin await — ese patrón
// dispara la deprecation de pg@9 "client.query() while another query is in
// flight". Esta forma es semánticamente equivalente y libre de race.
const TIME_ZONE = process.env.TZ || 'America/Argentina/Buenos_Aires';

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'gestion_creditos',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max:      parseInt(process.env.DB_MAX_CONNECTIONS || '10'),
  idleTimeoutMillis:       parseInt(process.env.DB_IDLE_TIMEOUT_MS || '30000'),
  connectionTimeoutMillis: 5000,
  options:                 `-c TimeZone=${TIME_ZONE}`,
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
