// Configuración jest para tests de INTEGRACIÓN (Postgres real).
// Cubre tests/integration/**/*.test.js.
//
// Requiere:
//   · `npm run test:db:up` previo (levanta docker-compose.test.yml).
//   · .env.test con las credenciales del Postgres de test.
//
// Características:
//   · globalSetup corre todas las migraciones reales contra la DB de test.
//   · globalTeardown cierra el pool global.
//   · Cada test file debe invocar `setupTestSuite()` del helper de db para
//     registrar beforeEach (truncate) y afterAll (close). Patrón explícito,
//     evita depender de opciones de jest que cambian entre versiones.
//   · maxWorkers=1: la DB es estado compartido — los tests corren en serie.
//   · testTimeout amplio: las operaciones reales de DB son más lentas que mocks.

module.exports = {
  testEnvironment: 'node',
  roots:           ['<rootDir>/tests/integration'],
  testMatch:       ['**/*.test.js'],
  globalSetup:     '<rootDir>/tests/integration/globalSetup.js',
  globalTeardown:  '<rootDir>/tests/integration/globalTeardown.js',
  testTimeout:     20000,
  maxWorkers:      1,
  verbose:         true,
  // El pool de pg deja conexiones idle (idleTimeoutMillis: 30s en src/config/db.js).
  // Los tests pasaron correctamente; forceExit asegura que jest libere el handle
  // sin esperar a que el pool se vacíe por timeout.
  forceExit:       true,
};
