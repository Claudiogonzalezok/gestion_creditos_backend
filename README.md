# Sistema de Gestión de Préstamos y Ventas a Crédito

API REST desarrollada con **Node.js + Express + PostgreSQL**.  
Gestiona el ciclo completo de préstamos en efectivo y ventas de productos a crédito, con flujo de doble control de cobros, liquidación de comisiones, caja diaria y portal público para clientes.

---

## Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| Runtime | Node.js 20+ |
| Framework | Express 4 |
| Base de datos | PostgreSQL 18 |
| Driver | pg (sin ORM) |
| Autenticación | JWT (jsonwebtoken) |
| Hashing | bcryptjs |
| Validación | express-validator |
| Scheduler | node-cron |
| Seguridad | helmet, cors |
| Logger | morgan |

---

## Arquitectura

```
src/
├── app.js
├── config/
│   ├── db.js
│   └── migrations/
│       └── 001_create_tables.sql        # Estructura completa (20 tablas)
├── jobs/
│   ├── overdueInstallments.job.js       # Cron 02:00 — mora automática
│   ├── creditExpiry.job.js              # Cron 03:00 — expiración de pre-operaciones
│   ├── weeklyCommissionCycle.job.js     # Cron sábado 23:59 — cierre semanal
│   └── tokenCleanup.job.js              # Cron 04:00 — limpieza de blacklist JWT
├── middlewares/
│   ├── auth.middleware.js
│   └── validate.middleware.js
├── modules/
│   ├── auth/
│   ├── users/
│   ├── customers/
│   ├── products/
│   ├── productRates/                    # Tasas de interés por producto (SALE)
│   ├── interestRates/                   # Tasas para préstamos en efectivo (LOAN)
│   ├── credits/
│   ├── installments/
│   ├── payments/
│   ├── collections/
│   ├── commissions/
│   ├── cashRegister/
│   ├── expenses/                        # Gastos operativos del negocio
│   ├── reports/
│   ├── systemConfig/
│   └── portal/
├── scripts/
│   └── migration.run.js                 # Ejecutor con tabla de control _migrations
├── seeds/
│   ├── 01_admin.seed.js
│   ├── 02_system_config.seed.js
│   ├── 03_interest_rates.seed.js
│   └── index.seed.js
└── utils/
    ├── creditCalculator.js
    ├── date.js                          # localDate() con timezone Argentina
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

---

## Roles

| Rol | Descripción |
|-----|-------------|
| `ADMIN` | Acceso total. Aprueba operaciones, cierra caja, liquida comisiones. |
| `SELLER` | Crea clientes y pre-operaciones. Ve sus propios créditos y comisiones. |
| `COLLECTOR` | Registra cobros. Ve sus planillas y clientes asignados (sin ver domicilios). |
| `SELLER_COLLECTOR` | Puede vender Y cobrar. Tiene sueldo fijo + comisiones. |
| `CLIENT` | Acceso al portal público (cronograma de cuotas, deuda). |

---

## Base de datos — 20 tablas

| # | Tabla | Descripción |
|---|-------|-------------|
| 1 | `users` | Usuarios internos |
| 2 | `customers` | Clientes del negocio |
| 3 | `products` | Catálogo de productos |
| 4 | `stock_movements` | Historial de stock |
| 5 | `interest_rates` | Coeficientes para LOAN (por rango de monto) |
| 6 | `product_rates` | Coeficientes para SALE (por producto + frecuencia + cuotas) |
| 7 | `credits` | Créditos SALE y LOAN |
| 8 | `credit_products` | Productos en ventas a crédito |
| 9 | `installments` | Cuotas del cronograma |
| 10 | `payments` | Pre-cargas de cobro (doble control) |
| 11 | `credit_down_payments` | Enganches y cuotas prepagadas al aprobar (impactan en caja) |
| 12 | `cash_registers` | Cierres de caja diarios |
| 13 | `collection_sheets` | Planillas de cobro |
| 14 | `collection_sheet_details` | Detalle de cuotas por planilla |
| 15 | `token_blacklist` | Tokens JWT revocados |
| 16 | `salaries` | Sueldos fijos semanales |
| 17 | `commissions` | Comisiones por ventas SALE |
| 18 | `commission_liquidations` | Liquidaciones semanales |
| 19 | `expenses` | Gastos operativos del negocio |
| 20 | `system_config` | Parámetros configurables |

### Campos clave en `credits`

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `down_payment` | NUMERIC | Enganche entregado al crear la venta |
| `down_payment_method` | VARCHAR | CASH o TRANSFER |
| `down_payment_transfer_reference` | VARCHAR | Referencia si fue transferencia |
| `prepaid_installments` | SMALLINT | Cuotas pagadas por adelantado al momento de la venta |
| `prepaid_installments_method` | VARCHAR | CASH o TRANSFER |
| `interest_rate` | NUMERIC | Coeficiente LOAN (NULL para SALE) |

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
# 1. Clonar
git clone https://github.com/Claudiogonzalezok/gestion_creditos_backend.git
cd gestion-creditos-backend

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env

# 4. Crear la base de datos
createdb -U postgres gestion_creditos

# 5. Ejecutar migraciones (detecta y aplica solo las nuevas)
npm run migration:run

# 6. Cargar semillas
npm run seed

# 7. Iniciar
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
```

> `JWT_EXPIRY_INTERNAL` y `JWT_EXPIRY_PORTAL` son valores por defecto. Los valores reales se leen dinámicamente de `system_config` en cada login.

### Scripts npm

```json
"start":           "node src/app.js",
"dev":             "nodemon src/app.js",
"dev:test":        "nodemon --env-file=.env.test src/app.js",
"seed":            "node src/seeds/index.seed.js",
"seed:test":       "node -r dotenv/config src/seeds/index.seed.js dotenv_config_path=.env.test",
"migration:run":   "node src/scripts/migration.run.js",
"migration:test":  "node -r dotenv/config src/scripts/migration.run.js dotenv_config_path=.env.test"
```

### Migration runner

`migration.run.js` mantiene una tabla `_migrations` en la BD y aplica solo los archivos `.sql` nuevos en orden alfabético. Idempotente: correrlo dos veces no rompe nada.

### Credenciales iniciales

```
DNI:        00000000
Contraseña: Admin1234
```

---

## Entornos paralelos

| | Producción | Pruebas |
|---|---|---|
| BD | `gestion_creditos` | `gestion_creditos_test` |
| Puerto | 3000 | 3001 |
| Comando | `npm run dev` | `npm run dev:test` |
| Semillas | `npm run seed` | `npm run seed:test` |

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

### Tasas por producto

```
GET    /api/product-rates?product_id=uuid   → Todas (o filtradas por producto)
GET    /api/product-rates/:id
POST   /api/product-rates                   → Body: product_id, payment_frequency, installments_count, rate
PUT    /api/product-rates/:id               → Actualizar rate o active
PATCH  /api/product-rates/:id/deactivate
PATCH  /api/product-rates/:id/activate
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

**Body cotizador SALE:**
```json
{
  "type": "SALE",
  "installments_count": 3,
  "payment_frequency": "MONTHLY",
  "products": [{ "product_id": "uuid", "quantity": 1 }],
  "down_payment": 30000
}
```

El cotizador SALE devuelve el desglose por producto con `installment_contribution` de cada ítem.

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

El endpoint `approve` detecta automáticamente si `amount_received` supera el saldo de la cuota actual y aplica el excedente a las siguientes cuotas en orden. Si se pagan cuotas adicionales completas, sus fechas se recorren con `shiftInstallmentDates`.

### Planillas

```
GET    /api/collections
GET    /api/collections/:id
POST   /api/collections
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
GET    /api/expenses                  → Listado paginado con filtro por fecha
GET    /api/expenses/:id
POST   /api/expenses                  → Body: amount, description, payment_method
DELETE /api/expenses/:id              → Solo si no está en un cierre de caja
```

Los gastos aparecen como egreso en el dashboard y en el cierre de caja del día en que se registran.

### Caja diaria

```
GET    /api/cash-register/dashboard
GET    /api/cash-register
GET    /api/cash-register/:id         → Incluye desglose: payments, down_payments, liquidations, expenses
POST   /api/cash-register/close       → Body: declared_cash, observations, force (opcional)
```

El campo `force: true` permite cerrar aunque haya pre-cargas PENDING del día. Sin `force`, el sistema avisa cuántas pre-cargas quedan pendientes.

El dashboard incluye:
- Cobros aprobados (payments APPROVED)
- Enganches y cuotas prepagadas (credit_down_payments)
- Gastos del día (expenses)
- Cobros pendientes de aprobación
- Balance neto del día

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

**Nuevos:**
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

Incluye validaciones cruzadas: `min_credit_amount` debe ser menor a `max_credit_amount`; `commission_week_close_day` y `commission_pay_day` no pueden ser iguales.

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

### Cierre de caja

```
Total recaudado = cobros APPROVED + enganches + cuotas prepagadas
Total egresos   = liquidaciones de comisiones + gastos del día
Diferencia      = declared_cash - cash_amount (efectivo)

Si hay pre-cargas PENDING → devuelve 409 con detalle
Usar force: true para cerrar igual

El cierre vincula automáticamente las liquidaciones del día como egresos.
```

---

## Cron jobs

| Job | Horario | Acción |
|-----|---------|--------|
| `overdueInstallments` | `0 2 * * *` | PENDING → OVERDUE + mora diaria |
| `creditExpiry` | `0 3 * * *` | Expira créditos en PENDING_APPROVAL |
| `weeklyCommissionCycle` | `59 23 * * {closeDay}` | Log de cierre semanal (día configurable) |
| `tokenCleanup` | `0 4 * * *` | Elimina tokens expirados de blacklist |

---

## Seguridad

- **JWT doble secreto:** `sistema-interno` y `portal-cliente`. Un token no funciona en el otro sistema.
- **Blacklist:** tokens revocados en `token_blacklist`. El cron job los limpia automáticamente.
- **Bloqueo por intentos:** configurable en `system_config.login_max_attempts` (default 3).
- **Contraseña temporal:** `is_temp_password = true` bloquea todos los endpoints salvo `/me/change-password`.
- **Invalidación por rol:** `force_relogin_at` invalida tokens emitidos antes del cambio de rol.
- **Expiración dinámica:** el tiempo de expiración del JWT se lee de `system_config` en cada login.

---

## Formato de respuestas

```json
{ "ok": true, "message": "OK", "data": {} }
{ "ok": false, "message": "Error", "errors": [{ "field": "x", "message": "y" }] }
```

| HTTP | Uso |
|------|-----|
| 200 | Éxito |
| 201 | Creación |
| 400 | Validación |
| 401 | No autenticado |
| 403 | Sin permisos |
| 404 | No encontrado |
| 409 | Conflicto de negocio |
| 422 | Monto supera saldo disponible |
| 500 | Error interno |
