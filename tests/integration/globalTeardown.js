// Global teardown ejecutado UNA SOLA VEZ después de toda la suite.
// No cierra pools: globalTeardown corre en un contexto distinto al de los
// test files, así que hacer require('src/config/db') acá crearía (y conectaría)
// un pool NUEVO en vez de cerrar el de los tests. Cada suite cierra su propio
// pool en el afterAll de setupTestSuite (helpers/db.js).

module.exports = async () => {};
