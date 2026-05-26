// Configuración jest para tests UNITARIOS (mocks).
// Cubre solo los archivos *.test.js colocados dentro de src/.
// No requiere infra externa — corre rápido y es CI-friendly por default.

module.exports = {
  testEnvironment: 'node',
  roots:           ['<rootDir>/src'],
  testMatch:       ['**/*.test.js'],
  // Excluye explícitamente la carpeta de integration para evitar mezclas.
  testPathIgnorePatterns: ['/node_modules/', '/tests/integration/'],
  verbose:         true,
};
