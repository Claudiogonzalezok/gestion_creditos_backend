#!/usr/bin/env node
// Decide qué tests corre CI para un conjunto de archivos cambiados.
// Uso: git diff --name-only <base>...HEAD | node scripts/ci-scope.mjs [--full]
// Imprime JSON:
//   { mode: 'none' | 'affected' | 'full', unitFiles: string[],
//     integrationTests: string[], lintFiles: string[] }
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Código compartido: cualquier cambio acá obliga a la suite completa.
const SHARED_PATTERNS = [
  /^src\/config\//,
  /^src\/utils\//,
  /^src\/middlewares\//,
  /^src\/app\.js$/,
  /^src\/jobs\//,
  /^package(-lock)?\.json$/,
  /^tests\/integration\/helpers\//,
  /^tests\/integration\/global(Setup|Teardown)\.js$/,
  /^jest(\.[a-z]+)?\.config\.js$/,
  /^eslint\.config\.js$/,
  /^docker-compose\.test\.yml$/,
  /^\.env\.test$/,
  /^scripts\/ci-scope/,
  /^\.github\//,
  // Corre en cada `pnpm install`, incluido el deploy de producción.
  /^\.husky\/install\.mjs$/,
];

// Rutas que nunca afectan tests: docs, scripts de hooks locales y herramientas de agentes.
const NO_TEST_IMPACT_PATTERN = /(\.md$)|(^docs\/)|(^\.husky\/pre-)|(^\.atl\/)|(^\.claude\/)/;
const MODULE_PATTERN = /^src\/modules\/([^/]+)\//;
const UNIT_TEST_PATTERN = /^tests\/unit\/.+\.test\.js$/;
const INTEGRATION_TEST_PATTERN = /^tests\/integration\/[^/]+\.test\.js$/;
const LINTABLE_PATTERN = /^(src|tests|scripts)\/.*\.(js|mjs)$/;

/**
 * Resuelve el alcance de tests de CI a partir de la lista de archivos cambiados.
 * @param {string[]} files - rutas cambiadas relativas al repositorio
 * @param {{ forceFull?: boolean, dependentsOf?: (modules: string[]) => string[],
 *   integrationTestsFor?: (modules: string[]) => string[],
 *   exists?: (file: string) => boolean }} [options] -
 *   forceFull corre todo (main, nightly, etiqueta ci:full); dependentsOf expande los
 *   módulos cambiados con los módulos que los importan; integrationTestsFor devuelve
 *   los tests de integración que referencian esos módulos; exists indica si el archivo
 *   sigue en disco (borrar o mover un archivo de un módulo corre la suite completa,
 *   porque --findRelatedTests no encuentra los tests que todavía lo importan)
 * @returns {{ mode: string, unitFiles: string[], integrationTests: string[], lintFiles: string[] }}
 */
export function resolveScope(
  files,
  {
    forceFull = false,
    dependentsOf = (m) => m,
    integrationTestsFor = () => [],
    exists = () => true,
  } = {},
) {
  const changed = [...new Set(files.map((f) => f.trim()).filter(Boolean))];
  const lintFiles = changed.filter((f) => LINTABLE_PATTERN.test(f));
  const full = { mode: 'full', unitFiles: [], integrationTests: [], lintFiles };

  if (forceFull) return full;

  const code = changed.filter((f) => !NO_TEST_IMPACT_PATTERN.test(f));
  if (code.length === 0) return { mode: 'none', unitFiles: [], integrationTests: [], lintFiles };

  const modules = new Set();
  const unitFiles = [];
  const integrationTests = new Set();
  for (const file of code) {
    if (SHARED_PATTERNS.some((p) => p.test(file))) return full;
    const match = MODULE_PATTERN.exec(file);
    if (match && !exists(file)) return full;
    if (match) {
      modules.add(match[1]);
      unitFiles.push(file);
    } else if (UNIT_TEST_PATTERN.test(file)) {
      unitFiles.push(file);
    } else if (INTEGRATION_TEST_PATTERN.test(file)) {
      integrationTests.add(file);
    } else {
      // Cualquier otra ruta corre todo: es más seguro que omitir tests en silencio.
      return full;
    }
  }

  if (modules.size > 0) {
    for (const test of integrationTestsFor(dependentsOf([...modules].sort()))) {
      integrationTests.add(test);
    }
  }

  return {
    mode: 'affected',
    unitFiles: unitFiles.sort(),
    integrationTests: [...integrationTests].sort(),
    lintFiles,
  };
}

/**
 * Lista los archivos .js de una carpeta en forma recursiva, con rutas relativas al repo.
 * @param {string} dir
 * @returns {string[]}
 */
function listJs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map((f) => join(dir, String(f)).replace(/\\/g, '/'))
    .filter((f) => f.endsWith('.js'));
}

/**
 * Expande los módulos con todos los módulos que los importan (clausura transitiva),
 * para que un cambio en un módulo también corra la integración de quienes lo usan.
 * @param {string[]} modules
 * @returns {string[]}
 */
function moduleDependentsOnDisk(modules) {
  const importsOf = new Map();
  for (const file of listJs('src/modules')) {
    const owner = MODULE_PATTERN.exec(file)?.[1];
    if (!owner) continue;
    const source = readFileSync(file, 'utf8');
    const set = importsOf.get(owner) ?? new Set();
    for (const m of source.matchAll(/require\(\s*['"](?:\.\.\/)+(?:modules\/)?([^/'".]+)\//g))
      set.add(m[1]);
    importsOf.set(owner, set);
  }
  const result = new Set(modules);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [owner, deps] of importsOf) {
      if (result.has(owner)) continue;
      if ([...deps].some((d) => result.has(d))) {
        result.add(owner);
        grew = true;
      }
    }
  }
  return [...result].sort();
}

/**
 * Devuelve los tests de integración que referencian alguno de los módulos.
 * @param {string[]} modules
 * @returns {string[]}
 */
function integrationTestsOnDisk(modules) {
  return listJs('tests/integration')
    .filter((f) => INTEGRATION_TEST_PATTERN.test(f))
    .filter((f) => {
      const source = readFileSync(f, 'utf8');
      return modules.some((m) => source.includes(`modules/${m}/`));
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = readFileSync(0, 'utf8');
  const scope = resolveScope(input.split('\n'), {
    forceFull: process.argv.includes('--full'),
    dependentsOf: moduleDependentsOnDisk,
    integrationTestsFor: integrationTestsOnDisk,
    exists: existsSync,
  });
  process.stdout.write(JSON.stringify(scope));
}
