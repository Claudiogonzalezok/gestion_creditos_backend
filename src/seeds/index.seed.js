require('dotenv').config();
const pool = require('../config/db');

const seed01 = require('./01_admin.seed');
const seed02 = require('./02_system_config.seed');
const seed03 = require('./03_interest_rates.seed');
const seed04 = require('./04_bulk_data.seed');

const seeds = [
  { name: 'Admin inicial',          fn: seed01 },
  { name: 'Parámetros del sistema', fn: seed02 },
  { name: 'Tasas de interés',       fn: seed03 },
  { name: 'Datos bulk E2E',         fn: seed04 },
];

const run = async () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║  🌱  SEMILLAS — Sistema Gestión Créditos  ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  try {
    for (let i = 0; i < seeds.length; i++) {
      const { name, fn } = seeds[i];
      console.log(`🌱  [${i + 1}/${seeds.length}] ${name}`);
      await fn();
      console.log('');
    }

    console.log('╔════════════════════════════════════════╗');
    console.log('║  ✅  Todas las semillas ejecutadas OK   ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    console.log('  Próximo paso: npm run dev');
    console.log('');
  } catch (err) {
    console.error('');
    console.error('❌  Error al ejecutar semillas:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

run();
