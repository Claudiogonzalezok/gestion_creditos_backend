// Ejecuta manualmente un cron job sin esperar al schedule.
// Útil para QA, debugging y validación post-deploy.
//
// Uso:
//   node src/scripts/run-cron.js <jobName>
//   npm run cron:run -- <jobName>
//
// Jobs disponibles:
//   · overdueInstallments    — marca OVERDUE y aplica mora con catch-up
//   · creditExpiry           — expira créditos en PENDING_APPROVAL viejos
//   · tokenCleanup           — limpia tokens expirados (blacklist/refresh)
//   · weeklyCommissionCycle  — cierre del ciclo semanal de comisiones

require('dotenv').config();

const JOBS = {
  overdueInstallments:   () => require('../jobs/overdueInstallments.job').markOverdueAndApplyPenalty(),
  creditExpiry:          () => require('../jobs/creditExpiry.job').expireOldCredits(),
  tokenCleanup:          () => require('../jobs/tokenCleanup.job').runCleanup(),
  weeklyCommissionCycle: () => require('../jobs/weeklyCommissionCycle.job').closeWeeklyCycle(),
};

const main = async () => {
  const jobName = process.argv[2];

  if (!jobName) {
    console.error('');
    console.error('  ❌  Falta el nombre del job.');
    console.error('');
    console.error('  Uso: node src/scripts/run-cron.js <jobName>');
    console.error('  Jobs disponibles:');
    Object.keys(JOBS).forEach((n) => console.error(`    · ${n}`));
    console.error('');
    process.exit(1);
  }

  if (!JOBS[jobName]) {
    console.error('');
    console.error(`  ❌  Job desconocido: "${jobName}"`);
    console.error(`  Disponibles: ${Object.keys(JOBS).join(', ')}`);
    console.error('');
    process.exit(1);
  }

  console.log('');
  console.log(`  ▶️   Ejecutando job: ${jobName}`);
  console.log('  ──────────────────────────────────────────────');

  const startedAt = Date.now();
  let result;
  try {
    result = await JOBS[jobName]();
  } catch (err) {
    console.error('  ❌  Error en el job:', err.message);
    process.exit(1);
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);

  console.log('  ──────────────────────────────────────────────');
  console.log(`  ✅  Job completado en ${elapsed}s.`);
  if (result !== undefined) {
    console.log('  Resultado:');
    console.log(JSON.stringify(result, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
  }
  console.log('');

  // Cerrar el pool para que el proceso termine limpiamente
  const pool = require('../config/db');
  await pool.end();
  process.exit(0);
};

main();
