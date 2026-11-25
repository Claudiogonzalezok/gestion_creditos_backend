# Estrategia de testing

El proyecto usa **estrategia mixta**: unit tests con mocks para lógica simple,
integration tests con Postgres real para lógica financiera y SQL crítico.

## Estructura

```
src/**/*.test.js              # Unit tests (jest.unit.config.js) — mocks, sin DB
tests/unit/**/*.test.js       # Unit tests de la infraestructura de tests (sin DB)
tests/integration/**/*.test.js # Integration tests (jest.integration.config.js) — Postgres real
tests/integration/helpers/    # db, fixtures, dates, jobs, testDbGuard
tests/integration/globalSetup.js     # Guarda + migrations + seed (una vez por run)
tests/integration/globalTeardown.js  # No-op: cada suite cierra su pool en setupTestSuite()
```

## Qué se mockea y qué NO

### Unit (`src/**/*.test.js`)
Mockeamos: `pool.query`, queries individuales, dependencias externas.
Sirven para: services sin lógica financiera, controllers, validators, cronLogger,
adapters. Son rápidos y CI-friendly.

### Integration (`tests/integration/**`)
**NO mockeamos** `pool.query` ni SQL. La directiva oficial del proyecto es:
> "No mockear lógica financiera. Testear comportamiento real."

Obligatorio integration para:
- Fórmulas de mora (`overdueInstallments.job.js`)
- `grace_days`
- Transitions de status (`updateInstallment`, `restoreInstallmentFromReversal`)
- SQL CASE complejos
- Locks / transactions
- Helpers SQL financieros (`installmentSql.js`)

## Cómo correr

### Unit tests (rápido, sin infra)

```bash
npm test           # alias de npm run test:unit
npm run test:unit
```

### Integration tests (requieren Postgres en docker)

```bash
# 1. Levantar el contenedor de test (una vez por sesión de desarrollo)
npm run test:db:up

# 2. Correr los tests
npm run test:integration

# 3. Bajar el contenedor cuando termines
npm run test:db:down
```

### Todo junto (CI)

```bash
npm run test:db:up && npm run test:all && npm run test:db:down
```

En GitHub Actions (`.github/workflows/ci.yml`) un PR corre solo los tests
afectados (ver "Calidad y CI" en el README raíz). La suite completa usa
`npm run test:unit:ci`, que exige el umbral de cobertura de
`jest.unit.config.js`. Al agregar un test de integración de un módulo, importá
el código desde `src/modules/<módulo>/`: CI usa esa referencia para decidir qué
tests de integración corre cuando cambia el módulo.

## Cómo escribir un test de integration

```javascript
const { pool, setupTestSuite } = require('./helpers/db');
const { createInstallmentFixture, reloadInstallment } = require('./helpers/fixtures');
const { daysAgo } = require('./helpers/dates');
const { markOverdueAndApplyPenalty } = require('../../src/jobs/overdueInstallments.job');

setupTestSuite(); // registra beforeEach (truncate) automáticamente

describe('mi feature', () => {
  it('aplica mora a cuota vencida', async () => {
    // 1. ARRANGE: crear fixture con due_date en el pasado
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(10),
      original_amount: 1000,
      status:          'OVERDUE',
    });

    // 2. ACT: correr el job real (sin mocks)
    await markOverdueAndApplyPenalty();

    // 3. ASSERT: leer estado actualizado y verificar invariantes
    const after = await reloadInstallment(inst.id);
    expect(after.penalty_amount).toBeGreaterThan(0);
    expect(after.amount_due).toBe(after.original_amount + after.penalty_amount);
  });
});
```

## Decisiones arquitectónicas

### Por qué TRUNCATE y no transacciones rollback

Postgres permite "transacción por test" como cleanup ultra-rápido. No la usamos
porque varios módulos (jobs, queries con `pool.connect()`) abren sus propias
transacciones; superponerlas a una externa rompe semántica de locks.

`TRUNCATE ... RESTART IDENTITY CASCADE` sobre las 14 tablas transaccionales
tarda <100ms y es robusto.

### Por qué no mockeamos CURRENT_DATE

PostgreSQL evalúa `CURRENT_DATE` contra el reloj del servidor. No hay forma
limpia de mockearlo desde JS sin reescribir queries. La estrategia del
proyecto es controlar las fechas de las **fixtures** (vía `daysAgo(n)`,
`daysFromNow(n)`) y dejar que el código real opere con el reloj real.

### Por qué `setupTestSuite()` explícito en cada test file

En vez de usar opciones de jest config (que cambiaron de nombre entre versiones),
cada test file invoca `setupTestSuite()` al tope. Explícito, robusto, sin
acoplarse a un release específico de jest.

### Guarda de base de test

Antes de crear cualquier pool, `globalSetup` y `helpers/db.js` llaman a
`helpers/testDbGuard.js`, que aborta si `NODE_ENV` no es `test` o si `DB_NAME`
no termina en `_test`. `truncateAll()` lo vuelve a verificar antes del
`TRUNCATE ... CASCADE`. Si falta `.env.test` o el entorno apunta a una base
real, la suite falla sin ejecutar ninguna query. `.env.test` se carga sin pisar
variables ya definidas, para que los scripts `:local` y `DB_PORT=...` funcionen.

### Por qué `.env.test` está commiteado

Las credenciales apuntan al Postgres del `docker-compose.test.yml` (puerto 5433,
contraseña `postgres_test`). No hay nada secreto que proteger; commitearlo
elimina fricción para correr tests en otra máquina o CI.

## Fixtures disponibles

| Helper | Auto-crea | Defaults razonables |
|--------|-----------|---------------------|
| `createCustomerFixture` | — | `Test Customer`, DNI único |
| `createCreditFixture`   | customer | LOAN, ACTIVE, 1 cuota, WEEKLY |
| `createInstallmentFixture` | credit (y customer) | número 1, vence hoy, $1000, PENDING |

Todos aceptan overrides parciales que se mergean sobre los defaults.

## Helpers de fecha

```javascript
today()           // 'YYYY-MM-DD' de hoy
daysAgo(10)       // 'YYYY-MM-DD' hace 10 días
daysFromNow(5)    // 'YYYY-MM-DD' en 5 días
isoDate(new Date()) // formatea cualquier Date
```

Las fechas se calculan en la zona horaria de la sesión de PostgreSQL
(`TZ` o, si no está, `America/Argentina/Buenos_Aires`, igual que
`src/config/db.js`), así coinciden con `CURRENT_DATE` aunque Node corra en otra
zona. La suite debe pasar igual con `TZ=UTC` y con `TZ=America/Argentina/Buenos_Aires`.

## Tablas de referencia

`interest_rates` y otras tablas de referencia no se truncan entre tests. Si una
suite las modifica, llamá `preserveTable("interest_rates")` antes de
`setupTestSuite()`: guarda las filas al inicio de la suite y las restaura al final.
Los `jest.spyOn` se restauran en un `finally` o `afterEach`, nunca solo al final
del test.

## Troubleshooting

**"[integration] Abortado: ..."**
La guarda detectó que la base no es de test. Verificá que exista `.env.test`, o
que `NODE_ENV=test` y que `DB_NAME` termine en `_test`.

**Windows: el puerto 5433 lo ocupa un Postgres nativo**
Levantá la base de test en otro puerto y pasalo por variable:
`npx cross-env DB_PORT=5434 jest --config jest.integration.config.js`.

**"No se pudo conectar a la DB de test"**
Levantá el contenedor: `npm run test:db:up`. Esperá ~3 segundos al primer arranque.

**Tests intermitentes / state leak entre runs**
El truncate corre antes de cada `it`. Si querés resetear TODO (migraciones
incluidas), bajá y volvé a levantar: `npm run test:db:down && npm run test:db:up`.

**Tests muy lentos**
Probablemente el contenedor no tiene healthcheck OK. Verificá con
`docker ps` que el container `gestion_creditos_test_db` esté `(healthy)`.
