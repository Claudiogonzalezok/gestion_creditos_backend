# Sistema de Gestión de Préstamos y Ventas a Crédito

API REST desarrollada con **Node.js + Express + PostgreSQL**.  
Gestiona el ciclo completo de préstamos en efectivo y ventas de productos a crédito, con flujo de doble control de cobros, liquidación de comisiones, modelo de caja V4 (jornada + caja operativa + tesorería), y portal público para clientes.

---

## Stack tecnológico

| Capa          | Tecnología                       |
| ------------- | -------------------------------- |
| Runtime       | Node.js 20+                      |
| Framework     | Express 5                        |
| Base de datos | PostgreSQL                       |
| Driver        | pg (sin ORM)                     |
| Autenticación | JWT (jsonwebtoken)               |
| Hashing       | bcryptjs                         |
| Validación    | express-validator                |
| Scheduler     | node-cron                        |
| Seguridad     | helmet, cors, express-rate-limit |
| Logger        | morgan                           |
| Docs          | swagger-ui-express               |

---

## Arquitectura

```
src/
├── app.js
├── config/
│   ├── db.js
│   └── migrations/                      # Archivos .sql numerados (idempotentes)
├── jobs/
│   ├── overdueInstallments.job.js        # Cron 02:00 — mora automática
│   ├── creditExpiry.job.js               # Cron 03:00 — expiración de pre-operaciones
│   ├── weeklyCommissionCycle.job.js      # Cron sábado 23:59 — cierre semanal
│   └── tokenCleanup.job.js              # Cron 04:00 — limpieza de blacklist JWT
├── middlewares/
│   ├── auth.middleware.js
│   └── validate.middleware.js
├── modules/
│   ├── auth/
│   ├── users/
│   ├── customers/
│   ├── products/
│   ├── productBrands/                   # Marcas de producto
│   ├── productCategories/               # Categorías de producto
│   ├── productVariants/                 # Variantes (color, talle, etc.)
│   ├── productUnits/                    # Unidades físicas (AVAILABLE → RESERVED → SOLD)
│   ├── productRates/                    # Tasas por producto (SALE)
│   ├── interestRates/                   # Tasas para préstamos en efectivo (LOAN)
│   ├── credits/
│   ├── installments/
│   ├── payments/
│   ├── collections/
│   ├── collectionAttempts/              # Intentos de cobro fallidos
│   ├── commissions/
│   ├── businessDays/                    # Jornadas contables (Caja V4)
│   ├── cashSessions/                    # Cajas operativas + drops + ingresos manuales (Caja V4)
│   ├── cashAccounts/                    # Tesorería / Caja General (Caja V4)
│   ├── cashRegister/                    # [LEGACY] — no agregar lógica nueva
│   ├── expenses/
│   ├── expenseCategories/               # Categorías de gastos
│   ├── holidays/                        # Feriados y días no hábiles
│   ├── notifications/                   # Notificaciones in-app + preferencias
│   ├── reports/
│   ├── systemConfig/
│   ├── cronLogs/                        # Log de ejecución de cron jobs
│   ├── portal/
│   └── test/                            # Rutas de test (solo activas con ENABLE_TEST_ROUTES=true)
├── scripts/
│   ├── migration.run.js                 # Setup seguro: crea BD si no existe + migraciones pendientes
│   ├── db.reset.js                      # Reset destructivo: borra, recrea y migra desde cero
│   ├── db.studio.js                     # Explorador de BD liviano en consola
│   └── run-cron.js                      # Ejecuta un cron job manualmente
├── seeds/
│   ├── 01_admin.seed.js
│   ├── 02_system_config.seed.js
│   ├── 03_interest_rates.seed.js
│   └── index.seed.js
└── utils/
    ├── businessDay.js                   # Cálculo de días hábiles (considera feriados)
    ├── cache.js                         # Cache en memoria con TTL (Map + sentinel undefined)
    ├── creditCalculator.js
    ├── cronLogger.js                    # Helper para registrar ejecuciones de cron en BD
    ├── date.js                          # localDate() con timezone Argentina
    ├── installmentSql.js                # Helpers SQL para cuotas
    ├── jwt.js
    ├── response.js
    ├── tempPassword.js
    ├── transaction.js
    └── validators.js
```

### Patrón

```
Request → Router → Controller → Service → Queries → PostgreSQL
```

### Cache en memoria (`utils/cache.js`)

Cache con TTL sin dependencias externas (no requiere Redis). Vive en el proceso Node.js.

| TTL                 | Uso                               |
| ------------------- | --------------------------------- |
| `TTL.SHORT` (5 min) | `system_config`                   |
| `TTL.LONG` (30 min) | `interest_rates`, `product_rates` |

- `get(key)` devuelve `undefined` para miss (no `null` — `null` es un valor legítimo cacheado).
- `invalidateByPrefix(prefix)` limpia todas las variantes de un mismo recurso.
- Mutaciones invalidan el cache vía `invalidateByPrefix` antes de retornar.

---

## Roles

| Rol                | Descripción                                                                  |
| ------------------ | ---------------------------------------------------------------------------- |
| `ADMIN`            | Acceso total. Aprueba operaciones, cierra caja, liquida comisiones.          |
| `SELLER`           | Crea clientes y pre-operaciones. Ve sus propios créditos y comisiones.       |
| `COLLECTOR`        | Registra cobros. Ve sus planillas y clientes asignados (sin ver domicilios). |
| `SELLER_COLLECTOR` | Puede vender Y cobrar. Tiene sueldo fijo + comisiones.                       |
| `CASHIER`          | Administra cajas operativas (Caja V4). Sin acceso a aprobaciones.            |
| `CLIENT`           | Acceso al portal público (cronograma de cuotas, deuda).                      |

---

## Base de datos

### Tablas núcleo

| #   | Tabla                      | Descripción                                                 |
| --- | -------------------------- | ----------------------------------------------------------- |
| 1   | `users`                    | Usuarios internos (con `phone` desde migración 040)         |
| 2   | `customers`                | Clientes del negocio                                        |
| 3   | `products`                 | Catálogo de productos                                       |
| 4   | `product_brands`           | Marcas de producto                                          |
| 5   | `product_categories`       | Categorías de producto                                      |
| 6   | `product_variants`         | Variantes por producto                                      |
| 7   | `product_units`            | Unidades físicas individuales                               |
| 8   | `stock_movements`          | Historial de stock                                          |
| 9   | `interest_rates`           | Coeficientes para LOAN (por rango de monto)                 |
| 10  | `product_rates`            | Coeficientes para SALE (por producto + frecuencia + cuotas) |
| 11  | `credits`                  | Créditos SALE y LOAN                                        |
| 12  | `credit_products`          | Productos en ventas a crédito                               |
| 13  | `installments`             | Cuotas del cronograma                                       |
| 14  | `payments`                 | Pre-cargas de cobro (doble control)                         |
| 15  | `credit_down_payments`     | Enganches y cuotas prepagadas al aprobar (impactan en caja) |
| 16  | `collection_sheets`        | Planillas de cobro                                          |
| 17  | `collection_sheet_details` | Detalle de cuotas por planilla                              |
| 18  | `collection_attempts`      | Intentos de cobro registrados por el cobrador               |
| 19  | `token_blacklist`          | Tokens JWT revocados                                        |
| 20  | `salaries`                 | Sueldos fijos semanales                                     |
| 21  | `commissions`              | Comisiones por ventas SALE                                  |
| 22  | `commission_liquidations`  | Liquidaciones semanales                                     |
| 23  | `expenses`                 | Gastos operativos del negocio                               |
| 24  | `expense_categories`       | Categorías de gastos                                        |
| 25  | `system_config`            | Parámetros configurables                                    |
| 26  | `holidays`                 | Feriados y días no hábiles                                  |
| 27  | `cron_execution_log`       | Log de ejecuciones de cron jobs                             |
| 28  | `notifications`            | Notificaciones in-app por usuario                           |
| 29  | `notification_preferences` | Preferencias globales de notificación por tipo              |

### Tablas Caja V4

| Tabla                          | Descripción                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `branches`                     | Sucursales/canales (preparado para multi-tenant)                                                                                      |
| `business_days`                | Jornada contable diaria por sucursal. Estados: `OPEN → READY_TO_CLOSE → CLOSED → AUDITED`                                             |
| `cash_sessions`                | Caja operativa por jornada (una por jornada, índice único total). Estados: `OPEN → CLOSED` o `OPEN → PENDING_RECONCILIATION → CLOSED` |
| `cash_session_drops`           | Retiros parciales de efectivo durante la sesión. `ACTIVE/REVERSED`                                                                    |
| `cash_session_closure_details` | Una fila por método de pago al cerrar (normaliza reconciliación)                                                                      |
| `cash_accounts`                | Cuentas de tesorería / Caja General. Balance cacheado con CHECK >= 0                                                                  |
| `cash_account_movements`       | Movimientos de tesorería: `DROP_IN`, `SALARY_PAYMENT`, `SUPPLIER_PAYMENT`, `EXPENSE`, `ADJUSTMENT`, `MANUAL_INCOME`                   |

### Tablas legacy (deprecated)

| Tabla            | Estado                                             |
| ---------------- | -------------------------------------------------- |
| `cash_registers` | Deprecated — no agregar lógica nueva. Ver Caja V4. |
| `cash_movements` | Deprecated — no agregar lógica nueva. Ver Caja V4. |

### Campos clave en `credits`

| Campo                             | Tipo     | Descripción                                          |
| --------------------------------- | -------- | ---------------------------------------------------- |
| `down_payment`                    | NUMERIC  | Enganche entregado al crear la venta                 |
| `down_payment_method`             | VARCHAR  | CASH o TRANSFER                                      |
| `down_payment_transfer_reference` | VARCHAR  | Referencia si fue transferencia                      |
| `prepaid_installments`            | SMALLINT | Cuotas pagadas por adelantado al momento de la venta |
| `prepaid_installments_method`     | VARCHAR  | CASH o TRANSFER                                      |
| `interest_rate`                   | NUMERIC  | Coeficiente LOAN (NULL para SALE)                    |
| `first_payment_date`              | DATE     | Fecha de la primera cuota (desde migración 028)      |
| `payment_condition`               | VARCHAR  | Condición de pago (desde migración 043)              |

### `credit_down_payments` — separado de `payments`

Los enganches y las cuotas prepagadas **no van a la tabla `payments`** (que es solo para el flujo de doble control del cobrador). Van a `credit_down_payments` con `payment_type`:

- `DOWN_PAYMENT` — enganche al crear la venta
- `PREPAID_INSTALLMENT` — cuotas adelantadas al crear la venta

Ambos impactan en caja directamente sin necesitar aprobación.

### Lógica de tasas

**SALE:** tabla `product_rates` (producto + frecuencia + cuotas). El coeficiente se congela en `credit_products.historical_rate` al aprobar. `credits.interest_rate` queda NULL.

**LOAN:** tabla `interest_rates` (frecuencia + cuotas + rango de monto).

### Fórmula de cuotas

```
capital = total_amount - down_payment - (cuotas_prepagadas × monto_cuota)
cuota   = Math.ceil(capital × (1 + rate) / n / 1000) × 1000
```

Para SALE con múltiples productos, la cuota se calcula por producto de forma proporcional (`getProductInstallmentContribution`) y se suma.

### Manejo de fechas

`date.js` expone `localDate()` que usa `TZ=America/Argentina/Buenos_Aires` para evitar el problema de offset UTC-3. El driver pg tiene configurado `types.setTypeParser(1082)` para no convertir columnas DATE a objetos Date de JS.

---

## Instalación

```bash
# 1. Instalar dependencias (respeta package-lock.json; también instala los hooks de git)
npm ci

# 2. Configurar variables de entorno
cp .env.example .env

# 3. Crear la base de datos, aplicar migraciones y cargar datos iniciales
npm run db:setup

# 4. Iniciar
npm run dev
```

### Variables de entorno

```env
PORT=3000
NODE_ENV=development
TZ=America/Argentina/Buenos_Aires

DB_HOST=localhost
DB_PORT=5432
DB_NAME=gestion_creditos
DB_USER=postgres
DB_PASSWORD=tu_password

JWT_SECRET_INTERNAL=secreto_interno_largo
JWT_EXPIRY_INTERNAL=8h
JWT_SECRET_PORTAL=secreto_portal_largo
JWT_EXPIRY_PORTAL=30m

ALLOWED_ORIGINS=http://localhost:4200
BCRYPT_SALT_ROUNDS=10

DISABLE_LOGIN_RATE_LIMIT=false   # Poner true en entorno e2e
TRUST_PROXY=loopback             # Proxies confiables para la IP real del cliente (default loopback: nginx en el mismo host)
ENABLE_TEST_ROUTES=false          # Poner true en entorno e2e
```

> `JWT_EXPIRY_INTERNAL` y `JWT_EXPIRY_PORTAL` son valores por defecto. Los valores reales se leen dinámicamente de `system_config` en cada login.

> **Configuración segura en producción** (`NODE_ENV=production`, ver `src/config/secureConfig.js`):
> - El arranque falla si `ENABLE_TEST_ROUTES=true` o si falta `DB_USER` / `DB_PASSWORD` (no hay fallback a `postgres` sin contraseña).
> - La documentación Swagger (`/api/docs`) no se monta y responde 404. En desarrollo sigue disponible.

### Scripts npm

| Comando                          | Descripción                                                |
| -------------------------------- | ---------------------------------------------------------- |
| `npm run db:setup`               | Primer setup: crea la BD si no existe + migraciones + seed |
| `npm run db:reset`               | ⚠️ Reset total: borra todo, recrea, migra y seedea         |
| `npm run migration:run`          | Solo aplica migraciones nuevas (no destructivo)            |
| `npm run seed`                   | Solo ejecuta el seed                                       |
| `npm run dev`                    | Servidor en modo desarrollo con hot reload                 |
| `npm run dev:e2e`                | Servidor sin rate limit en login + test routes activas     |
| `npm start`                      | Servidor en modo producción                                |
| `npm run test:unit`              | Tests unitarios con Jest (mock de BD)                      |
| `npm run test:unit:ci`           | Unitarios con cobertura y umbral mínimo (como en CI)       |
| `npm run test:scope`             | Tests del script que decide el alcance de CI               |
| `npm run lint -- <archivos>`     | ESLint sobre archivos puntuales (sin warnings permitidos)  |
| `npm run format -- <archivos>`   | Prettier sobre archivos puntuales                          |
| `npm run test:integration`       | Tests de integración con BD real (Docker)                  |
| `npm run test:integration:local` | Tests de integración con BD local (sin Docker)             |
| `npm run test:all`               | Unit + integration en secuencia                            |
| `npm run test:db:up`             | Levanta BD PostgreSQL de test en Docker                    |

**Setup re-ejecutable.** `migration:run` y `seed` se pueden correr las veces que haga falta:

- Las migraciones aplicadas se registran por nombre en `_migrations` y no se repiten. Un advisory lock evita que dos procesos migren a la vez. Los prefijos repetidos históricos (002, 006, 007, 033, 037) ya están aplicados en producción y no se renumeran; un prefijo repetido nuevo aborta el runner. Las correcciones van en migraciones nuevas (p. ej. 051 bloquea el `DELETE` físico de planillas).
- Las semillas abortan con `NODE_ENV=production`, no cambian contraseñas de usuarios existentes y no duplican datos. La demo de planillas admin solo se regenera a mano con `node src/seeds/11_admin_collections_ui_refresh.seed.js`.
- `tests/integration/idempotent-setup.test.js` corre migraciones y semillas dos veces sobre una BD vacía y compara `password_hash` y conteos.
| `npm run test:db:down`           | Baja y elimina el contenedor de test                       |
| `npm run cron:run`               | Ejecuta un cron job manualmente                            |
| `npm run db:studio`              | Explorador de BD liviano en consola                        |

### Migration runner

`migration.run.js` conecta primero a la base `postgres` del sistema para crear la BD si no existe, luego aplica solo los archivos `.sql` nuevos en orden alfabético usando la tabla `_migrations` como control. Es idempotente: correrlo dos veces no rompe nada.

`db.reset.js` hace lo mismo pero primero cierra todas las conexiones activas y elimina la base antes de recrearla. Usar solo en desarrollo.

### Credenciales iniciales

```
DNI:        00000000
Contraseña: Admin1234
```

---

## Tests

### Unitarios (`test:unit`)

Usan Jest con mocks de `../../config/db`. Cada suite hace `cache.clearAll()` en `beforeEach` para aislar el estado en memoria. Archivos `.test.js` junto al módulo que prueban.

### Integración (`test:integration`)

Corren contra una BD PostgreSQL real levantada en Docker (`docker-compose.test.yml`). Requieren `npm run test:db:up` antes de ejecutarlos. Usan `supertest` sobre la app Express completa.

---

## Calidad y CI

**Hooks de git** (Husky, se instalan con `npm ci`; en producción con `--omit=dev` se omiten sin error):
- `pre-commit`: ESLint (`--max-warnings 0`) y Prettier (`--write`) solo sobre los archivos staged.
- `pre-push`: tests del script de alcance y suite unitaria (`npm run test:unit`).

**Lint incremental:** no se reformatea el repo de una vez. Cada archivo que tocás tiene que quedar limpio. Reglas: `eslint:recommended`, sin `console.log` (se permiten `console.warn` y `console.error`; los scripts, seeds, jobs y tests quedan exentos). La regla "sin `any`" no aplica: el backend es JavaScript.

**Workflow `.github/workflows/ci.yml`** corre solo lo que el PR tocó. El alcance lo decide `scripts/ci-scope.mjs`:

| Qué se tocó | Qué corre |
|---|---|
| Solo docs (`*.md`, `docs/`) o los hooks `.husky/pre-*` | Nada de tests |
| Un módulo (`src/modules/<x>`) | Lint de los cambiados + unitarios relacionados (`jest --findRelatedTests`) + tests de integración que referencian ese módulo o a los módulos que lo importan |
| Un test (`tests/unit/*`, `tests/integration/*.test.js`) | Ese test |
| Código compartido (`src/config/`, `src/utils/`, `src/middlewares/`, `src/app.js`, `src/jobs/`, `package*.json`, `tests/integration/helpers/`, configs de jest/eslint, `docker-compose.test.yml`, `.env.test`, `.github/`, `.husky/install.mjs`), un archivo de módulo borrado o movido, o cualquier otro archivo no listado | Suite completa: unitarios con umbral de cobertura + integración |

- La suite completa también corre al mergear a `main`, todas las noches (si falla, abre o actualiza un issue con la etiqueta `ci:nightly`) y en un PR con la etiqueta `ci:full`.
- El umbral de cobertura está en `jest.unit.config.js` (53% de líneas, base del 2026-11-25). Subilo cuando la cobertura crezca; nunca lo bajes.
- Para que el workflow bloquee el merge hay que marcar el check `Lint, unit and integration tests` como requerido en la protección de la rama `main` (configuración de GitHub, no del repo).

---

## Backups de producción

Backup diario cifrado de la base, con copia en Google Drive y ensayo de restore en Docker: ver [`docs/backups.md`](docs/backups.md).

---

## Endpoints

### Paginación de listados (opcional)

Los listados `GET /api/payments`, `/api/installments`, `/api/users`, `/api/commissions`, `/api/collection-attempts` y `/api/cash-sessions` aceptan paginación **opcional** (helper `src/utils/pagination.js`):

| Parámetro | Rango | Notas |
|---|---|---|
| `limit` | 1–100 | Tamaño de página. Si solo se envía `page`/`offset`, vale 50. |
| `offset` | 0–1.000.000 | Filas a saltear. Tiene prioridad sobre `page`. |
| `page` | 1–100.000 | Página 1-based; `offset = (page - 1) × limit`. |

- **Sin ninguno de los tres**, la respuesta es la de siempre: `data` es el array completo (compatibilidad con el frontend actual).
- **Con alguno**, `data` trae solo la página y se agrega `pagination: { total, limit, offset }`, donde `total` es la cantidad de filas que cumplen los filtros.
- Valores fuera de rango o no numéricos → `400`.

Ejemplo: `GET /api/payments?status=APPROVED&limit=20&page=2` →
`{ "ok": true, "message": "OK", "data": [...20 filas], "pagination": { "total": 137, "limit": 20, "offset": 20 } }`

Otras cotas de entrada:
- `GET /api/notifications`: `page` 1–100.000 y `limit` 1–100 (default 20). Mantiene su formato propio.
- `GET /api/credits/simulate/products` (público): `limit` 1–50 (default 10).
- `GET /api/cash-accounts/:id/movements` ya paginaba con `page`/`page_size` (máx. 100).
- `POST /api/product-variants` y `/bulk`: `initial_units` 0–10.000 por variante y como suma total del lote (las filas sin `initial_units` cuentan 1).
- `POST /api/product-units/bulk`: `units` admite entre 1 y 10.000 unidades por lote (middleware + servicio).
- La generación de planillas inserta los detalles por lotes de 1000 filas (límite de 65535 parámetros de Postgres).


### Autenticación

```
POST /api/auth/login               → Login sistema interno
POST /api/auth/refresh             → Renovar access token (cookie rt, rotación atómica)
POST /api/auth/logout              → Cerrar sesión (invalida JWT)
GET  /api/auth/me                  → Usuario autenticado
POST /api/auth/portal/login        → Login portal público
POST /api/auth/portal/logout       → Cerrar sesión portal
```

### Usuarios

```
GET    /api/users
GET    /api/users/:id
POST   /api/users
PUT    /api/users/:id
PATCH  /api/users/:id/deactivate
PATCH  /api/users/:id/activate
PATCH  /api/users/:id/reset-password
PATCH  /api/users/:id/unlock
PATCH  /api/users/me/change-password
```

### Clientes

```
GET    /api/customers
GET    /api/customers/:id            → COLLECTOR: solo clientes asignados (404 si no)
POST   /api/customers
PUT    /api/customers/:id
PATCH  /api/customers/:id/deactivate | activate
PATCH  /api/customers/:id/enable-portal | disable-portal
PATCH  /api/customers/:id/reset-portal-password
PATCH  /api/customers/:id/unlock-portal
```

### Productos

```
GET    /api/products
GET    /api/products/:id
POST   /api/products
PUT    /api/products/:id
PATCH  /api/products/:id/stock
PATCH  /api/products/:id/deactivate | activate
```

### Marcas de producto

```
GET    /api/product-brands
GET    /api/product-brands/:id
POST   /api/product-brands                  → ADMIN
PUT    /api/product-brands/:id              → ADMIN
PATCH  /api/product-brands/:id/deactivate   → ADMIN
PATCH  /api/product-brands/:id/activate     → ADMIN
```

### Categorías de producto

```
GET    /api/product-categories
POST   /api/product-categories              → ADMIN
PUT    /api/product-categories/:id          → ADMIN
PATCH  /api/product-categories/:id/deactivate | activate → ADMIN
```

### Variantes de producto

```
GET    /api/product-variants?product_id=uuid&status=ACTIVE
GET    /api/product-variants/:id
POST   /api/product-variants                → ADMIN
POST   /api/product-variants/bulk           → ADMIN (creación masiva, todo o nada en una transacción)
PUT    /api/product-variants/:id            → ADMIN
PATCH  /api/product-variants/:id/deactivate | activate → ADMIN
```

### Unidades de producto

```
GET    /api/product-units?variant_id=uuid&product_id=uuid&status=AVAILABLE
GET    /api/product-units/:id
POST   /api/product-units                   → ADMIN
POST   /api/product-units/bulk              → ADMIN (creación masiva)
PATCH  /api/product-units/:id               → ADMIN (unit_code / notes)
PATCH  /api/product-units/:id/deactivate | activate → ADMIN
```

### Tasas por producto

```
GET    /api/product-rates?product_id=uuid
GET    /api/product-rates/:id
POST   /api/product-rates
PUT    /api/product-rates/:id
PATCH  /api/product-rates/:id/deactivate | activate
```

### Tasas de interés (LOAN)

```
GET    /api/interest-rates
GET    /api/interest-rates/:id
POST   /api/interest-rates
PUT    /api/interest-rates/:id
PATCH  /api/interest-rates/:id/deactivate | activate
```

### Créditos

```
POST   /api/credits/simulate          → Cotizador (sin token)
GET    /api/credits
GET    /api/credits/:id            → COLLECTOR: solo créditos de clientes asignados o de su planilla (404 si no)
GET    /api/credits/:creditId/payments → Historial de cobros; mismo alcance que el detalle
POST   /api/credits
PATCH  /api/credits/:id/approve
PATCH  /api/credits/:id/reject
PATCH  /api/credits/:id/early-settlement
PATCH  /api/credits/:id/write-off     → Castigo de crédito irrecuperable (ADMIN)
GET    /api/credits/:id/plan-change/simulate → Simulación del cambio de plan (ADMIN, no persiste)
POST   /api/credits/:id/plan-change   → Ejecución del cambio de plan (ADMIN)
```

#### Cambio de plan con sobrepago (`excess_disposition`)

Si el cliente ya pagó más que el total del nuevo plan, el saldo recalculado es negativo y el excedente **no se descarta**: el cliente elige qué hacer con él.

| Aspecto | Contrato |
|---|---|
| Simulación | La respuesta incluye `excessAmount` (monto pagado de más, `0` si no hay) y `requiresExcessDisposition` (`true` si `excessAmount > 0`). `cancelledInstallments` es exactamente lo que anula la ejecución (si el crédito se cancela, incluye la cuota sobreviviente). |
| Body de ejecución | `reason` (opcional) y `excess_disposition`: `"CREDIT_BALANCE"` o `"REFUND"`. Obligatorio solo si hay excedente; sin excedente se ignora. |
| Falta o es inválido con excedente | `422` con `code: "EXCESS_DISPOSITION_REQUIRED"`. No se modifica nada. |
| `CREDIT_BALANCE` | El excedente queda como saldo a favor en `credits.credit_balance`. Sin movimiento de caja. |
| `REFUND` | Devolución en efectivo imputada a la caja operativa activa de la jornada (`credit_plan_changes.refund_cash_session_id`). Se descuenta del esperado de caja dentro de `outflows_loans_cash` (desglose en `outflows_plan_change_refunds_cash`). Sin caja activa → `409` con `code: "NO_ACTIVE_SESSION"`. |
| Respuesta de ejecución | Igual que la simulación, más `excessDisposition` (`null` sin excedente), `plan_change_id` y `executed_at`. |

La auditoría (`credit_plan_changes`) guarda `excess_amount`, `excess_disposition` y `refund_cash_session_id` (migración 050). Aplica a créditos LOAN y SALE.

**Body crear SALE:**

```json
{
  "customer_id": "uuid",
  "type": "SALE",
  "installments_count": 3,
  "payment_frequency": "MONTHLY",
  "products": [{ "product_id": "uuid", "quantity": 1 }],
  "down_payment": 50000,
  "down_payment_method": "CASH",
  "prepaid_installments": 1,
  "prepaid_installments_method": "TRANSFER",
  "prepaid_installments_transfer_reference": "TRF-001"
}
```

### Cuotas

```
GET    /api/installments
GET    /api/installments/:id
PATCH  /api/installments/:id/apply-penalty
PATCH  /api/installments/:id/waive-penalty
PATCH  /api/installments/:id/early-pay
```

### Cobros (payments)

```
GET    /api/payments?status=&collector_id=&installment_id=&date_from=&date_to=&created_from=&created_to=
GET    /api/payments/:id
POST   /api/payments                  → Registrar pre-carga
PATCH  /api/payments/:id/approve      → Aprueba y aplica adelanto automático si sobra saldo
PATCH  /api/payments/:id/reject
POST   /api/payments/admin-direct     → Cobro directo sin pre-carga (solo ADMIN)
POST   /api/payments/:id/reverse      → Revertir cobro aprobado (solo ADMIN)
```

Filtros de fecha de `GET /api/payments` (YYYY-MM-DD, inclusivos, combinables con los demás filtros y la paginación):

- `date_from` / `date_to`: fecha de **aprobación** (`approved_at`). Excluyen las pre-cargas `PENDING`.
- `created_from` / `created_to`: fecha de **registro** (`created_at`). Incluyen `PENDING`. `created_to` debe ser mayor o igual a `created_from` (si no, 400).

Un cobrador siempre ve solo sus propios cobros, con cualquier filtro.

#### Cobro directo: `POST /api/payments/admin-direct`

Es la única vía de cobro que **saltea el doble control** (pre-carga del cobrador → aprobación del Admin): el pago nace `APPROVED` y se aplica a la cuota en el acto. Por eso está restringido:

- **Rol:** solo `ADMIN` (`authorize('ADMIN')` en la ruta; cualquier otro rol recibe `403`).
- **Caja:** requiere una caja operativa activa en la jornada; si no hay → `409`. El monto se imputa a esa caja.
- **Body:** `installment_id` (UUID, obligatorio) y los montos con el mismo formato que la pre-carga (`amount_received` + `payment_method`, o `amount_cash` / `amount_transfer`), `transfer_reference` y `notes` opcionales.
- **Trazabilidad:** el pago queda con `admin_direct = true` y `approved_by` = el Admin que lo registró.
- Cuota ya `PAID` o crédito `SETTLED` → `409`. El excedente se aplica como adelanto, igual que en `approve`.

La reversión (`POST /api/payments/:id/reverse`, body `reason` de 5 a 500 caracteres) también es solo `ADMIN` y nunca borra el pago original: genera un contramovimiento.

Soporta cobros con método mixto (efectivo + transferencia): campos `amount_cash` / `amount_transfer` opcionales.

El endpoint `approve` detecta automáticamente si `amount_received` supera el saldo de la cuota actual y aplica el excedente a las siguientes cuotas en orden. Si se pagan cuotas adicionales completas, sus fechas se recorren con `shiftInstallmentDates`. Si después de cubrir todas las cuotas pendientes todavía sobra dinero (el saldo bajó entre la pre-carga y la aprobación), la aprobación se rechaza con `409` y no se registra ningún movimiento de caja: todo lo que entra a caja queda imputado a una cuota.

#### Pre-carga idempotente: `client_request_id`

`POST /api/payments` acepta un campo opcional `client_request_id` en el **body** para que un doble toque o un reintento de red no cree dos pre-cargas por el mismo cobro.

| Aspecto | Contrato |
|---|---|
| Campo | `client_request_id` en el body JSON (no header). UUID (cualquier versión; se recomienda v4). Otro formato → `400`. |
| Quién lo genera | El cliente, **uno por intento de cobro**. Se reutiliza en los reintentos de ese mismo intento; un cobro nuevo lleva una clave nueva. |
| Alcance de unicidad | Por cobrador: `(collector_id, client_request_id)`. Dos cobradores no colisionan. Índice UNIQUE parcial en `payments` (migración 049). |
| Primera request | `201` con la pre-carga creada (incluye `client_request_id`). |
| Reintento con la misma clave, misma cuota y mismo monto | `200` con la pre-carga **existente** (en su estado actual, aunque ya esté aprobada o rechazada) y `idempotent_replay: true`. No crea otra fila ni repite notificaciones. |
| Misma clave con otra cuota u otro monto | `409` con `code: "IDEMPOTENCY_KEY_REUSED"`. No crea nada. |
| Sin `client_request_id` | Comportamiento anterior (sin deduplicación), compatible con clientes viejos. |

Además, la creación corre en una transacción que bloquea la cuota y el crédito (`SELECT ... FOR UPDATE`) antes de recalcular el saldo disponible: dos pre-cargas concurrentes que juntas superan el saldo dejan pasar una sola; la otra recibe `409`/`422`. No se bloquea la caja (el cobrador no opera caja).

### Planillas

```
GET    /api/collections
GET    /api/collections/:id
POST   /api/collections
```

### Intentos de cobro

```
GET    /api/collection-attempts?collector_id=uuid&installment_id=uuid
GET    /api/collection-attempts/:id
POST   /api/collection-attempts
PATCH  /api/collection-attempts/:id/void → Solo quien lo creó (created_by) o ADMIN; si no, 403
```

### Comisiones

```
GET    /api/commissions
GET    /api/commissions/weekly-summary
GET    /api/commissions/liquidations
POST   /api/commissions/liquidate
GET    /api/commissions/salary/:userId
PUT    /api/commissions/salary/:userId
```

### Gastos

```
GET    /api/expenses
GET    /api/expenses/:id
POST   /api/expenses                  → category_id UUID obligatorio
DELETE /api/expenses/:id              → Solo si no está en un cierre de caja
```

### Categorías de gastos

```
GET    /api/expense-categories
POST   /api/expense-categories
PATCH  /api/expense-categories/:id/activate | deactivate
```

### Feriados

```
GET    /api/holidays?type=NATIONAL&active=true&affects_due_dates=true
GET    /api/holidays/:id
POST   /api/holidays
POST   /api/holidays/duplicate-year/preview
POST   /api/holidays/duplicate-year
PUT    /api/holidays/:id
```

### Jornadas contables (Caja V4)

```
GET    /api/business-days?status=OPEN&branch_id=uuid&date_from=&date_to=   → ADMIN
GET    /api/business-days/active?branch_id=uuid                            → ADMIN
GET    /api/business-days/:id                                              → ADMIN
POST   /api/business-days/:id/close                                        → ADMIN
POST   /api/business-days/:id/force-close   → body: reason (obligatorio)  → ADMIN
POST   /api/business-days/:id/audit                                        → ADMIN
```

### Cajas operativas (Caja V4)

```
POST   /api/cash-sessions              → Abrir caja de jornada. body: opening_amount, owner_user_id, branch_id
GET    /api/cash-sessions/active       → Caja activa del momento
GET    /api/cash-sessions?status=&owner_user_id=&business_day_id=&business_date=&branch_id=
GET    /api/cash-sessions/:id
GET    /api/cash-sessions/:id/snapshot → Snapshot completo de la caja (movimientos, balance)

POST   /api/cash-sessions/:id/close         → Cierre formal. body: declared[] [{payment_method, declared_amount}]
POST   /api/cash-sessions/:id/mark-pending  → Marcar pendiente de reconciliación. body: reason
POST   /api/cash-sessions/:id/reconcile     → Reconciliar. body: declared[]

POST   /api/cash-sessions/:id/drops                       → Registrar retiro parcial
POST   /api/cash-sessions/:id/drops/:dropId/reverse       → Revertir retiro. body: reason

POST   /api/cash-sessions/:id/manual-incomes              → Ingreso manual a caja (amount o amount_cash/amount_transfer)
```

### Tesorería / Caja General (Caja V4)

```
GET    /api/cash-accounts                   → ADMIN
GET    /api/cash-accounts/:id               → ADMIN
GET    /api/cash-accounts/:id/balance       → ADMIN
GET    /api/cash-accounts/:id/audit-balance → ADMIN
GET    /api/cash-accounts/:id/movements?movement_type=&direction=&from=&to=&page=&page_size=  → ADMIN
POST   /api/cash-accounts/:id/movements    → ADMIN
       movement_type: SUPPLIER_PAYMENT | EXPENSE | ADJUSTMENT | MANUAL_INCOME
```

### Notificaciones

```
GET    /api/notifications                         → Historial del usuario autenticado
GET    /api/notifications/unread-count            → Badge de no leídas
POST   /api/notifications/:id/read               → Marcar como leída
POST   /api/notifications/read-all               → Marcar todas como leídas
DELETE /api/notifications/:id
DELETE /api/notifications                         → Eliminar todas las del usuario

GET    /api/notifications/preferences             → ADMIN — preferencias globales
PUT    /api/notifications/preferences/:type       → ADMIN — actualizar preferencia por tipo
```

Tipos de notificación: `MORA`, `INSTALLMENT_DUE`, `APPROVAL_REQUEST`, `CASH_REGISTER`, `NEW_CUSTOMER`.

`MORA` se emite una sola vez por cuota: cuando el job nocturno la pasa de `PENDING`/`PARTIAL` a `OVERDUE`. Las corridas siguientes siguen aplicando punitorios a cuotas ya vencidas pero no las re-notifican.

### Reportes

```
GET    /api/reports/collection?date_from=&date_to=
GET    /api/reports/portfolio
GET    /api/reports/overdue
GET    /api/reports/collectors?date_from=&date_to=
GET    /api/reports/products?stock_threshold=5
GET    /api/reports/upcoming?days=30
GET    /api/reports/summary
```

- `summary` — resumen ejecutivo del día actual en una sola query
- `upcoming` — vencimientos próximos por día y por cliente
- `products` — incluye `low_stock`, `active_rates_count` y desglose de tasas configuradas
- `overdue` — segmentado por aging buckets (1-30d, 31-60d, 61-90d, +90d)
- `portfolio` — incluye top 10 clientes por saldo pendiente
- `collectors` — incluye `avg_approval_hours` (tiempo promedio de aprobación)
  - `total_payments`, `approved_count`, `rejected_count` y `approval_rate` cuentan todos los cobros del cobrador en el rango (aprobados, rechazados y pendientes; las filas de reversión no cuentan). La jornada de un cobro es la de su caja; si no tiene, la fecha de aprobación/rechazo y, para pendientes, la de creación.
  - `total_collected` netea las reversiones igual que `collection` (la reversión resta en su propia jornada), así ambos reportes coinciden para el mismo rango.

**Montos exactos:** los cálculos nuevos de dinero (cronograma de simulación, imputación de cobros, saldos de cancelación/castigo/cambio de plan) se hacen en centavos enteros (`src/utils/money.js`). En el cronograma, la suma del capital de todas las cuotas es exactamente el capital financiado (la última cuota absorbe el resto). No se recalcula ningún monto ya persistido.

### Configuración del sistema

```
GET    /api/system-config
GET    /api/system-config/:key
PUT    /api/system-config/:key
POST   /api/system-config/:key/reset
```

`PUT /api/system-config/:key` valida el `value` de forma estricta: debe ser un decimal simple (`"5"`, `"0.08"`, o un número JSON). Se rechazan con `400` los valores con texto (`"12abc"`), notación científica o hexadecimal, vacíos, `NaN`/`Infinity`, tipos no escalares y cualquier negativo; además cada clave conocida tiene su rango. El valor se guarda normalizado (`" 7 "` → `"7"`).

### Portal público

```
GET    /api/portal/me
GET    /api/portal/credits
GET    /api/portal/credits/:id
```

---

## Flujos de negocio

### SALE con enganche y cuotas adelantadas

```
Vendedor crea pre-venta:
  └── Indica productos, cuotas, frecuencia
  └── Opcional: down_payment + down_payment_method (enganche)
  └── Opcional: prepaid_installments + prepaid_installments_method (cuotas al firmar)

Admin aprueba:
  1. Lee tasa de product_rates por producto
  2. Capital = total_amount - down_payment
  3. Genera cuotas sobre el capital
  4. Si prepaid_installments > 0:
       a. Marca esas cuotas como PAID
       b. Registra credit_down_payment tipo PREPAID_INSTALLMENT
       c. Corre fechas de las cuotas restantes (shiftInstallmentDates)
  5. Si down_payment > 0:
       Registra credit_down_payment tipo DOWN_PAYMENT
  6. Descuenta stock
  7. Genera comisión sobre total_amount (precio bruto, sin descuentos)
```

### Cobro con adelanto automático

```
Cobrador registra monto que supera el saldo de la cuota actual
  └── El sistema valida que no supere el saldo TOTAL del crédito

Admin aprueba (PATCH /payments/:id/approve):
  1. Aplica el monto a la cuota principal
  2. Si sobra saldo y la cuota quedó PAID:
       Aplica excedente a cuotas siguientes en orden
       Cuota cubierta completa → PAID con nota "Pago adelantado"
       Cuota cubierta parcial → PARTIAL
  3. Si se pagaron cuotas adicionales completas (paidCount > 0):
       Corre fechas de las cuotas restantes con shiftInstallmentDates
  4. Verifica si el crédito quedó totalmente SETTLED
```

### Modelo de Caja V4

```
Jornada (business_days):
  └── OPEN → READY_TO_CLOSE → CLOSED → AUDITED
  └── Una jornada por sucursal por día

Caja operativa (cash_sessions):
  └── Una por jornada (índice único total sobre business_day_id)
  └── OPEN → CLOSED  |  OPEN → PENDING_RECONCILIATION → CLOSED
  └── Todos los cobros aprobados, gastos, drops y reversiones se imputan aquí
  └── Sin caja activa → 409 NO_ACTIVE_SESSION

Tesorería (cash_accounts):
  └── Recibe drops de caja, paga sueldos/comisiones/proveedores
  └── SALARY_PAYMENT solo disponible vía commissions.liquidate (no por endpoint público)
  └── current_balance con CHECK >= 0 en BD
```

> Referencia completa en `docs/cash-model-v4.md` (fuente de verdad arquitectónica).

---

## Cron jobs

| Job                     | Horario                | Acción                                   |
| ----------------------- | ---------------------- | ---------------------------------------- |
| `overdueInstallments`   | `0 2 * * *`            | PENDING → OVERDUE + mora diaria          |
| `creditExpiry`          | `0 3 * * *`            | Expira créditos en PENDING_APPROVAL      |
| `weeklyCommissionCycle` | `59 23 * * {closeDay}` | Log de cierre semanal (día configurable) |
| `tokenCleanup`          | `0 4 * * *`            | Elimina tokens expirados de blacklist    |

Cada ejecución queda registrada en `cron_execution_log` (estado, duración, error si hubo).  
`npm run cron:run` permite disparar un job manualmente en desarrollo.

Cada corrida toma un advisory lock de PostgreSQL por job (`pg_try_advisory_lock(hashtext('cron:<job>'))`):
si otra instancia (PM2 en cluster, `cron:run` manual) ya está ejecutando ese job, la corrida se saltea
sin registrarse en `cron_execution_log`. Si no hay conexión para tomar el lock, la corrida no se ejecuta.

---

## Ciclo de vida del proceso

- **Health check:** `GET /api/health` ejecuta `SELECT 1` con timeout (`HEALTH_DB_TIMEOUT_MS`, default 2000 ms).
  Responde `200 { ok: true, db: "up" }` o `503 { ok: false, db: "down" }` si la base no responde. No reinicia el proceso.
- **Cierre ordenado:** ante `SIGTERM`/`SIGINT` (PM2 stop/reload) el servidor deja de aceptar conexiones, espera a que
  terminen las requests en curso, detiene los cron y cierra el pool. Si no termina en `SHUTDOWN_TIMEOUT_MS`
  (default 10000 ms) sale forzado con código 1.
- **Errores no manejados:** `unhandledRejection`/`uncaughtException` se loguean y disparan el mismo cierre con código 1
  (PM2 reinicia el proceso). Un error de un cliente ocioso del pool (`pool.on('error')`) se loguea sin tirar el proceso.
- **Transacciones:** si el `ROLLBACK` falla, se loguea, se relanza el error original y la conexión se libera con
  error para que el pool la descarte (`withTransaction` y jobs con transacción manual).

---

## Seguridad

- **JWT doble secreto:** `sistema-interno` y `portal-cliente`. Un token no funciona en el otro sistema.
- **Blacklist:** tokens revocados en `token_blacklist`. El cron job los limpia automáticamente.
- **Bloqueo por intentos:** configurable en `system_config.login_max_attempts` (default 3). El incremento y la decisión de bloqueo son un solo `UPDATE ... RETURNING`: una ráfaga paralela no supera el umbral sin bloquear.
  - No-ADMIN: bloqueo permanente (`locked_at`) hasta que un Admin lo desbloquee. Al bloquearse se cierran sus sesiones.
  - ADMIN: bloqueo **temporal** (`users.locked_until`, migración 052) de `system_config.admin_lock_minutes` minutos (default 15). Nunca se bloquea de forma permanente. Vencido el bloqueo, el conteo reinicia.
  - Portal: el login responde siempre el mismo mensaje genérico si el DNI no existe, el portal no está habilitado, la cuenta está inactiva o la contraseña es incorrecta. El bloqueo solo se informa con la contraseña correcta.
- **Rate limit:** `express-rate-limit` en los endpoints de login. Desactivable con `DISABLE_LOGIN_RATE_LIMIT=true` para entornos e2e. El mensaje 429 indica los minutos que faltan para que venza la ventana real (`LOGIN_RATE_LIMIT_WINDOW_MS`).
- **IP real del cliente (`TRUST_PROXY`):** `app.set('trust proxy', ...)` cuenta el rate limit por la IP de `X-Forwarded-For` solo si la conexión viene de un proxy confiable. Default `loopback`: producción tiene nginx en el mismo host proxyando a `127.0.0.1:3001` (un salto). Valores: `true`/`false`, un número de saltos (`1`) o una lista de subredes (`loopback, 10.0.0.0/8`). No usar `true` a ciegas: permitiría falsificar la IP con el header.
- **Contraseña temporal:** `is_temp_password = true` bloquea todos los endpoints salvo `/me/change-password`.
- **Cierre de sesiones del lado del servidor:** cambiar el rol, resetear la contraseña, desactivar o bloquear a un usuario fija `force_relogin_at` y revoca todos sus refresh tokens en la misma transacción. El middleware rechaza los access tokens emitidos antes (y los de usuarios bloqueados); `/refresh` rechaza usuarios bloqueados.
- **Rotación atómica del refresh token:** el token usado se revoca con `UPDATE ... WHERE revoked = FALSE RETURNING`. Si dos pestañas refrescan a la vez con la misma cookie, solo una obtiene token nuevo; la otra recibe `401 REFRESH_TOKEN_ROTATED`.

### Contrato de errores de autenticación (frontend)

Las respuestas de login, refresh y del middleware mantienen el status **401** y la forma `{ ok: false, message }` de siempre. Se agrega un campo opcional `code` para manejo programático (y `retry_after_seconds` + header `Retry-After` en el bloqueo temporal). Un cliente que ignore `code` sigue funcionando igual.

| `code`                  | Dónde                                   | Qué significa / qué hacer                                                                                   |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| _(sin code)_            | login                                   | Credenciales incorrectas (mensaje genérico).                                                                |
| `ACCOUNT_LOCKED`        | login interno y portal                  | Cuenta bloqueada por seguridad; requiere desbloqueo del Admin / negocio.                                    |
| `ACCOUNT_TEMP_LOCKED`   | login interno (solo ADMIN)              | Bloqueo temporal. `retry_after_seconds` indica cuándo reintentar.                                           |
| `SESSION_REVOKED`       | refresh y endpoints protegidos (middleware) | La sesión fue cerrada del lado del servidor (bloqueo, desactivación, reset, cambio de rol o reuso de un refresh revocado). Descartar tokens e ir al login sin reintentar refresh. |
| `REFRESH_TOKEN_ROTATED` | refresh                                 | Otro refresh concurrente ya rotó el token. La cookie vigente es la del ganador: reintentar el refresh una vez o ir al login. |
| `TOKEN_EXPIRED`         | endpoints protegidos (en `message`, sin cambios) | Access token vencido: hacer refresh.                                                                    |

Nota: `iat` del JWT tiene resolución de segundos; un token emitido en el mismo segundo que la invalidación también se rechaza.
- **Expiración dinámica:** el tiempo de expiración del JWT se lee de `system_config` en cada login.

---

## Formato de respuestas

```json
{ "ok": true, "message": "OK", "data": {} }
{ "ok": false, "message": "Error", "errors": [{ "field": "x", "message": "y" }] }
```

| HTTP | Uso                           |
| ---- | ----------------------------- |
| 200  | Éxito                         |
| 201  | Creación                      |
| 400  | Validación                    |
| 401  | No autenticado                |
| 403  | Sin permisos                  |
| 404  | No encontrado                 |
| 409  | Conflicto de negocio          |
| 422  | Monto supera saldo disponible |
| 500  | Error interno                 |
