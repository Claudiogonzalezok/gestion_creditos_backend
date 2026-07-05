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
# 1. Instalar dependencias
npm install

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
ENABLE_TEST_ROUTES=false          # Poner true en entorno e2e
```

> `JWT_EXPIRY_INTERNAL` y `JWT_EXPIRY_PORTAL` son valores por defecto. Los valores reales se leen dinámicamente de `system_config` en cada login.

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
| `npm run test:integration`       | Tests de integración con BD real (Docker)                  |
| `npm run test:integration:local` | Tests de integración con BD local (sin Docker)             |
| `npm run test:all`               | Unit + integration en secuencia                            |
| `npm run test:db:up`             | Levanta BD PostgreSQL de test en Docker                    |
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

## Endpoints

### Autenticación

```
POST /api/auth/login               → Login sistema interno
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
GET    /api/customers/:id
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
POST   /api/product-variants/bulk           → ADMIN (creación masiva)
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
GET    /api/credits/:id
POST   /api/credits
PATCH  /api/credits/:id/approve
PATCH  /api/credits/:id/reject
PATCH  /api/credits/:id/early-settlement
PATCH  /api/credits/:id/write-off     → Castigo de crédito irrecuperable (ADMIN)
PATCH  /api/credits/:id/plan-change   → Modificación de plan de pago (ADMIN)
```

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
GET    /api/payments
GET    /api/payments/:id
POST   /api/payments                  → Registrar pre-carga
PATCH  /api/payments/:id/approve      → Aprueba y aplica adelanto automático si sobra saldo
PATCH  /api/payments/:id/reject
```

Soporta cobros con método mixto (efectivo + transferencia): campos `amount_cash` / `amount_transfer` opcionales.

El endpoint `approve` detecta automáticamente si `amount_received` supera el saldo de la cuota actual y aplica el excedente a las siguientes cuotas en orden. Si se pagan cuotas adicionales completas, sus fechas se recorren con `shiftInstallmentDates`.

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
PATCH  /api/collection-attempts/:id/void
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

### Configuración del sistema

```
GET    /api/system-config
GET    /api/system-config/:key
PUT    /api/system-config/:key
POST   /api/system-config/:key/reset
```

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

---

## Seguridad

- **JWT doble secreto:** `sistema-interno` y `portal-cliente`. Un token no funciona en el otro sistema.
- **Blacklist:** tokens revocados en `token_blacklist`. El cron job los limpia automáticamente.
- **Bloqueo por intentos:** configurable en `system_config.login_max_attempts` (default 3).
- **Rate limit:** `express-rate-limit` en los endpoints de login. Desactivable con `DISABLE_LOGIN_RATE_LIMIT=true` para entornos e2e.
- **Contraseña temporal:** `is_temp_password = true` bloquea todos los endpoints salvo `/me/change-password`.
- **Invalidación por rol:** `force_relogin_at` invalida tokens emitidos antes del cambio de rol.
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
