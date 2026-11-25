// Semilla puntual — SOLO usuarios (admin + operativos), sin datos demo (productos, clientes, créditos)
// Uso: node src/seeds/seed-users-only.js
require('dotenv').config();

// Abortar antes de abrir conexiones si el entorno es producción (issue #53).
try {
  require('./guard').assertSeedAllowed();
} catch (err) {
  console.error(`❌  ${err.message}`);
  process.exit(1);
}

const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const seedAdmin = require('./01_admin.seed');

const seedOperationalUsers = async () => {
  const check = await pool.query(`SELECT id FROM users WHERE dni = '11111111'`);
  const operationalPassword = '123456';
  const hash = await bcrypt.hash(operationalPassword, 10);

  if (check.rows.length > 0) {
    // Re-ejecutar NO toca credenciales existentes (issue #53).
    console.log('   ⏭️   Usuarios operativos ya existen — se conservan sus contraseñas.');
    return;
  }

  console.log('  Creando usuarios operativos...');
  await pool.query(
    `INSERT INTO users (full_name, dni, email, address, password_hash, role, status, is_temp_password)
     VALUES ($1,$2,$3,$4,$5,'SELLER','ACTIVE',FALSE)`,
    ['Carlos Mendoza', '11111111', 'vendedor@sistema.com', 'Av. Corrientes 1234, CABA', hash]
  );

  await pool.query(
    `INSERT INTO users (full_name, dni, email, address, password_hash, role, status, is_temp_password)
     VALUES ($1,$2,$3,$4,$5,'COLLECTOR','ACTIVE',FALSE)`,
    ['María González', '22222222', 'cobrador@sistema.com', 'Av. Santa Fe 567, CABA', hash]
  );

  await pool.query(
    `INSERT INTO users (full_name, dni, email, address, password_hash, role, status, is_temp_password)
     VALUES ($1,$2,$3,$4,$5,'SELLER_COLLECTOR','ACTIVE',FALSE)`,
    ['Juan Rodríguez', '33333333', 'mixto@sistema.com', 'Av. Corrientes 999, CABA', hash]
  );

  console.log('   ✅  Usuarios operativos listos (DNI 11111111 / 22222222 / 33333333, pass 123456).');
};

const run = async () => {
  try {
    await seedAdmin();
    await seedOperationalUsers();
    console.log('');
    console.log('✅  Usuarios disponibilizados (sin datos demo).');
  } catch (err) {
    console.error('❌  Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

run();
