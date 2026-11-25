// Lint incremental: CI y el hook pre-commit solo lintean los archivos cambiados,
// así el código existente se corrige a medida que se toca, sin un reformateo masivo.
// El proyecto es JavaScript: la regla "sin any" de APP-STANDARD no aplica (no hay TypeScript).
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**', 'logs/**', '.claude/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    files: ['**/*.test.js', 'tests/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
  {
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // CLIs, seeds, jobs y tests reportan por consola a propósito.
    files: ['src/scripts/**', 'src/seeds/**', 'src/jobs/**', 'scripts/**', 'tests/**'],
    rules: { 'no-console': 'off' },
  },
];
