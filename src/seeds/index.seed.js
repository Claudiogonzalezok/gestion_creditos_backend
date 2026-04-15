require('dotenv').config();
const pool = require('../config/db');

const seed01 = require('./01_admin.seed');
const seed02 = require('./02_system_config.seed');
const seed03 = require('./03_interest_rates.seed');

const run = async () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║  🌱  SEMILLAS — Sistema Gestión Créditos  ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  try {
    await seed01();
    console.log('');
    await seed02();
    console.log('');
    await seed03();
    console.log('');
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
