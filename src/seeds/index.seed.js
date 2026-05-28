require('dotenv').config();
const pool = require('../config/db');

const seed01 = require('./01_admin.seed');
const seed02 = require('./02_system_config.seed');
const seed03 = require('./03_interest_rates.seed');
const seed04 = require('./04_bulk_data.seed');
const seed05 = require('./05_e2e.seed');
const seed06 = require('./06_expenses_ui.seed');
const seed07 = require('./07_liquidations_ui.seed');
const seed09 = require('./09_collector_payments_ui.seed');

const seeds = [
  { name: 'Admin inicial',          fn: seed01 },
  { name: 'Parámetros del sistema', fn: seed02 },
  { name: 'Tasas de interés',       fn: seed03 },
  { name: 'Datos bulk E2E',         fn: seed04 },
  { name: 'Datos E2E Tests',       fn: seed05 },
  { name: 'Gastos visuales UI',    fn: seed06 },
  { name: 'Liquidaciones visuales UI', fn: seed07 },
  { name: 'Cobros visuales cobrador UI', fn: seed09 },
  { name: 'Forzar recarga datos E2E',   fn: async () => { console.log('   ⚠️   Recarga omitida — ejecutar seed 05 manualmente si es necesario'); } },
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
