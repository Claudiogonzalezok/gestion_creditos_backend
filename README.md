# Sistema de Gestión de Préstamos y Créditos — Backend

API REST para la gestión integral de préstamos personales y ventas de productos a crédito.

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 5 |
| Base de datos | PostgreSQL 14+ |
| Autenticación | JWT (jsonwebtoken) |
| Hashing | bcryptjs |
| Validaciones | express-validator |
| Seguridad HTTP | helmet, cors |
| Tareas programadas | node-cron |

---

## Instalación paso a paso

### 1. Clonar e instalar dependencias

```bash
git clone <url-del-repositorio>
cd gestion_creditos_backend
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Editá `.env` con tus valores:

```env
# Servidor
PORT=3000
NODE_ENV=development

# Base de datos
DB_HOST=localhost
DB_PORT=5432
DB_NAME=gestion_creditos
DB_USER=postgres
DB_PASSWORD=tu_password

# JWT — sistema interno (Admin, Vendedor, Cobrador)
JWT_SECRET_INTERNAL=secreto_interno_muy_largo_y_aleatorio
JWT_EXPIRY_INTERNAL=8h

# JWT — portal público (Cliente)
JWT_SECRET_PORTAL=secreto_portal_muy_largo_y_aleatorio
JWT_EXPIRY_PORTAL=30m

# CORS — URLs del frontend separadas por coma
ALLOWED_ORIGINS=http://localhost:4200,http://localhost:4201

# Zona horaria para cron jobs
TZ=America/Argentina/Buenos_Aires
```

> ⚠️ **Importante:** los nombres correctos son `JWT_SECRET_INTERNAL` y `JWT_SECRET_PORTAL`.
> Cualquier otra variante causará error 401 en todos los endpoints.

### 3. Crear la base de datos

```bash
createdb -U postgres gestion_creditos
```

O desde pgAdmin: click derecho en **Databases** → **Create** → `gestion_creditos`.

### 4. Ejecutar la migración

```bash
npm run migration:run
```

Crea las 17 tablas con índices y constraints.

### 5. Ejecutar las semillas

```bash
npm run seed
```

Carga:
- Usuario Admin inicial (contraseña temporal: `Admin1234`)
- Parámetros del sistema (`system_config`)
- Tasas de interés (`interest_rates`) con los coeficientes reales del negocio

### 6. Iniciar el servidor

```bash
npm run dev    # desarrollo (hot reload con nodemon)
npm start      # producción
```

Verificar: `GET http://localhost:3000/api/health`

---

## Scripts disponibles

| Comando | Descripción |
|---|---|
| `npm run dev` | Inicia con nodemon (recarga automática) |
| `npm start` | Inicia en modo producción |
| `npm run seed` | Ejecuta todas las semillas en orden |
| `npm run migration:run` | Crea las tablas en la base de datos |

---

## Credenciales iniciales

| Campo | Valor |
|---|---|
| DNI | `00000000` |
| Contraseña | `Admin1234` |

> El sistema pedirá cambiar la contraseña en el primer acceso.

---

## Roles del sistema

| Rol | Descripción |
|---|---|
| `ADMIN` | Control total. Aprueba operaciones, gestiona usuarios, cierra caja, ejecuta liquidaciones. |
| `SELLER` | Registra clientes, genera pre-ventas y pre-préstamos, consulta sus comisiones. |
| `COLLECTOR` | Registra cobros en calle, consulta planillas asignadas. |
| `SELLER_COLLECTOR` | Puede vender Y cobrar. Tiene sueldo fijo + comisiones. |

---

## Endpoints principales

### Autenticación
```
POST /api/auth/login           → Login sistema interno
POST /api/auth/logout          → Cerrar sesión
GET  /api/auth/me              → Usuario autenticado
POST /api/auth/portal/login    → Login portal público (Cliente)
POST /api/auth/portal/logout   → Cerrar sesión portal
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
PATCH  /api/customers/:id/deactivate
PATCH  /api/customers/:id/activate
PATCH  /api/customers/:id/enable-portal
PATCH  /api/customers/:id/disable-portal
PATCH  /api/customers/:id/reset-portal-password
PATCH  /api/customers/:id/unlock-portal
```

### Productos
```
GET    /api/products
GET    /api/products/:id
POST   /api/products
PUT    /api/products/:id
PATCH  /api/products/:id/stock        → { movement: "IN"|"OUT", quantity, reason }
PATCH  /api/products/:id/deactivate
PATCH  /api/products/:id/activate
```

### Tasas de interés
```
GET    /api/interest-rates
GET    /api/interest-rates/:id
POST   /api/interest-rates
PUT    /api/interest-rates/:id
PATCH  /api/interest-rates/:id/deactivate
PATCH  /api/interest-rates/:id/activate
```

### Créditos
```
POST   /api/credits/simulate    → Cotizador (sin token requerido)
GET    /api/credits
GET    /api/credits/:id
POST   /api/credits
PATCH  /api/credits/:id/approve
PATCH  /api/credits/:id/reject
PATCH  /api/credits/:id/early-settlement
```

### Cuotas
```
GET    /api/installments
GET    /api/installments/:id
PATCH  /api/installments/:id/apply-penalty
PATCH  /api/installments/:id/waive-penalty
```

### Cobros
```
GET    /api/payments
GET    /api/payments/:id
POST   /api/payments
PATCH  /api/payments/:id/approve
PATCH  /api/payments/:id/reject
```

### Planillas de cobro
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

### Caja
```
GET    /api/cash-register/dashboard
GET    /api/cash-register
GET    /api/cash-register/:id
POST   /api/cash-register/close
```

### Reportes
```
GET    /api/reports/collection    → ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
GET    /api/reports/portfolio
GET    /api/reports/overdue
GET    /api/reports/collectors    → ?date_from=&date_to=
GET    /api/reports/products
```

### Portal público (cliente autenticado)
```
GET    /api/portal/me
GET    /api/portal/credits
GET    /api/portal/credits/:id
```

### Configuración del sistema
```
GET    /api/system-config
GET    /api/system-config/:key
PUT    /api/system-config/:key
POST   /api/system-config/:key/reset
```

---

## Cálculo de cuotas

```js
// creditCalculator.js
// Redondea al millar superior para cuotas "redondas"
cuota = Math.ceil((monto × (1 + coeficiente) / cantCuotas) / 1000) × 1000

// Ejemplo: $200.000, 3 cuotas, coeficiente 0.80
// totalConInteres = 200.000 × 1.80 = 360.000
// cuota = Math.ceil(360.000 / 3 / 1000) × 1000 = 120.000
```

## Tabla de coeficientes (frecuencia mensual)

| Rango de monto | 1 cuota | 2 cuotas | 3 cuotas | 4 cuotas |
|---|:---:|:---:|:---:|:---:|
| Hasta $100.000 | 1,32 | 1,54 | 1,89 | — |
| $100.001 - $150.000 | 1,30 | 1,57 | 1,85 | — |
| $150.001 - $200.000 | 1,28 | 1,55 | 1,80 | 1,96 |
| $200.001 - $300.000 | 1,25 | 1,48 | 1,80 | 1,96 |
| $300.001 - $400.000 | 1,24 | 1,47 | 1,80 | 1,95 |
| $400.001 - $500.000 | 1,22 | 1,44 | 1,68 | 1,88 |
| Más de $500.000 | 1,22 | 1,44 | 1,68 | 1,88 |

> En la tabla `interest_rates` el campo `rate` es el coeficiente menos 1 (ej: coef 1.32 → rate 0.32).

---

## Tareas programadas (cron jobs)

| Job | Horario | Descripción |
|---|---|---|
| `overdueInstallments` | Todos los días 02:00 | Pasa cuotas a OVERDUE y aplica mora diaria |
| `creditExpiry` | Todos los días 03:00 | Expira créditos con más de N días sin respuesta |
| `weeklyCommissionCycle` | Sábados 23:59 | Cierra el ciclo semanal y loguea el resumen |

---

## Formato de respuestas

```json
// Éxito
{ "ok": true, "message": "...", "data": {} }

// Error de validación
{ "ok": false, "message": "Datos inválidos...", "errors": [{ "field": "dni", "message": "..." }] }

// Error de negocio
{ "ok": false, "message": "No se puede desactivar el único administrador activo." }
```

---

## Configurar Postman

1. **Environments** → **Add** → nombre: `gestion_creditos_dev`
2. Variables:

| Variable | Valor inicial |
|---|---|
| `base_url` | `http://localhost:3000/api` |
| `token` | *(vacío)* |
| `token_portal` | *(vacío)* |

3. En el request `POST {{base_url}}/auth/login`, pestaña **Tests**:

```javascript
const json = pm.response.json();
if (json.ok && json.data && json.data.token) {
    pm.environment.set("token", json.data.token);
    console.log("✅ Token guardado");
}
```

4. En todos los demás requests: **Authorization** → **Bearer Token** → `{{token}}`

---

## Estructura del proyecto

```
src/
├── app.js
├── config/
│   ├── db.js
│   └── migrations/
│       └── 001_create_tables.sql
├── jobs/
│   ├── overdueInstallments.job.js
│   ├── creditExpiry.job.js
│   └── weeklyCommissionCycle.job.js
├── middlewares/
│   ├── auth.middleware.js
│   └── validate.middleware.js
├── modules/
│   ├── auth/
│   ├── users/
│   ├── customers/
│   ├── products/
│   ├── credits/
│   ├── installments/
│   ├── payments/
│   ├── collections/
│   ├── commissions/
│   ├── cashRegister/
│   ├── reports/
│   ├── interestRates/
│   ├── systemConfig/
│   └── portal/
├── scripts/
│   └── migration.run.js
├── seeds/
│   ├── 01_admin.seed.js
│   ├── 02_system_config.seed.js
│   ├── 03_interest_rates.seed.js
│   └── index.seed.js
└── utils/
    ├── creditCalculator.js
    ├── jwt.js
    ├── response.js
    ├── tempPassword.js
    ├── transaction.js
    └── validators.js
```
