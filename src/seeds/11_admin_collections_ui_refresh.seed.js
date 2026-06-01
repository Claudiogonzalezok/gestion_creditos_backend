require('dotenv').config();
const seed10 = require('./10_admin_collections_ui_states.seed');

/**
 * Wrapper de refresco rápido para la demo visual de planillas admin.
 * Reejecuta la semilla 10 y deja el escenario listo para probar colores/estados.
 */
const seed = async () => {
  await seed10();
  console.log('   OK seed 11: demo de planillas admin refrescada.');
};

module.exports = seed;

if (require.main === module) {
  seed()
    .then(() => {
      console.log('\nOK Seed 11 completado.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\nError:', err.message);
      process.exit(1);
    });
}
