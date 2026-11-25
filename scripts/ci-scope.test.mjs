import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScope } from './ci-scope.mjs';

test('un cambio solo de docs no corre tests', () => {
  const scope = resolveScope(['README.md', 'docs/cash-model-v4.md', '.husky/pre-push']);
  assert.equal(scope.mode, 'none');
  assert.deepEqual(scope.unitFiles, []);
  assert.deepEqual(scope.integrationTests, []);
});

test('un cambio de módulo corre sus unitarios relacionados y la integración de ese módulo', () => {
  const seen = [];
  const scope = resolveScope(['src/modules/payments/payments.service.js'], {
    dependentsOf: (m) => [...m, 'collections'],
    integrationTestsFor: (m) => {
      seen.push(...m);
      return ['tests/integration/payments-findall.test.js'];
    },
  });
  assert.equal(scope.mode, 'affected');
  assert.deepEqual(scope.unitFiles, ['src/modules/payments/payments.service.js']);
  assert.deepEqual(scope.integrationTests, ['tests/integration/payments-findall.test.js']);
  assert.deepEqual(seen, ['payments', 'collections']);
});

test('el código compartido obliga a la suite completa', () => {
  for (const file of [
    'src/config/migrations/040_x.sql',
    'src/config/db.js',
    'src/utils/dates.js',
    'src/middlewares/auth.middleware.js',
    'src/app.js',
    'src/jobs/overdueInstallments.job.js',
    'package.json',
    'package-lock.json',
    'tests/integration/helpers/fixtures.js',
    'tests/integration/globalSetup.js',
    'jest.unit.config.js',
    'eslint.config.js',
    'docker-compose.test.yml',
    '.github/workflows/ci.yml',
  ]) {
    assert.equal(resolveScope([file]).mode, 'full', file);
  }
});

test('el código compartido gana sobre un cambio de módulo', () => {
  const scope = resolveScope(['src/modules/credits/credits.service.js', 'src/utils/cache.js']);
  assert.equal(scope.mode, 'full');
});

test('rutas desconocidas caen en la suite completa', () => {
  for (const file of ['src/seeds/index.seed.js', 'src/scripts/db.reset.js', 'otro.js']) {
    assert.equal(resolveScope([file]).mode, 'full', file);
  }
});

test('un test de integración cambiado corre ese archivo', () => {
  const scope = resolveScope(['tests/integration/smoke.test.js']);
  assert.equal(scope.mode, 'affected');
  assert.deepEqual(scope.integrationTests, ['tests/integration/smoke.test.js']);
  assert.deepEqual(scope.unitFiles, []);
});

test('un test unitario de infraestructura se corre por relación', () => {
  const scope = resolveScope(['tests/unit/dates.test.js']);
  assert.equal(scope.mode, 'affected');
  assert.deepEqual(scope.unitFiles, ['tests/unit/dates.test.js']);
});

test('el lint apunta solo a archivos js cambiados', () => {
  const scope = resolveScope([
    'src/modules/payments/payments.service.js',
    'src/config/migrations/040_x.sql',
    'scripts/ci-scope.mjs',
    'README.md',
  ]);
  assert.deepEqual(scope.lintFiles, [
    'src/modules/payments/payments.service.js',
    'scripts/ci-scope.mjs',
  ]);
});

test('la corrida forzada ignora la lista de archivos', () => {
  assert.equal(resolveScope(['README.md'], { forceFull: true }).mode, 'full');
});
