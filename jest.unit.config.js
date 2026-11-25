// Configuración jest para tests UNITARIOS (mocks).
// Cubre solo los archivos *.test.js colocados dentro de src/.
// No requiere infra externa — corre rápido y es CI-friendly por default.

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests/unit'],
  testMatch: ['**/*.test.js'],
  // Excluye explícitamente la carpeta de integration para evitar mezclas.
  testPathIgnorePatterns: ['/node_modules/', '/tests/integration/'],
  verbose: true,
  // Umbral de cobertura (solo aplica con --coverage, p. ej. `npm run test:unit:ci`).
  // Base medida el 2026-11-25: 53.24% líneas, 52.2% sentencias, 38.76% funciones, 30% ramas.
  // Subirlo cuando la cobertura crezca; nunca bajarlo.
  coverageThreshold: {
    global: { lines: 53, statements: 51, functions: 38, branches: 29 },
  },
};
