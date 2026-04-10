# Sistema de Gestión de Préstamos y Créditos — Backend

API REST para la gestión integral de préstamos personales y ventas de productos a crédito. Incluye dos portales de acceso: uno operativo interno (Admin, Vendedor, Cobrador) y uno para clientes.

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Runtime | Node.js |
| Framework | Express 5 |
| Base de datos | PostgreSQL |
| Autenticación | JWT (jsonwebtoken) |
| Hashing | bcryptjs |
| Validaciones | express-validator |
| Seguridad HTTP | helmet, cors |
| Tareas programadas | node-cron |
| Logger | morgan |

## Requisitos previos

- Node.js 18+
- PostgreSQL 14+

## Instalación

```bash
git clone <url-del-repositorio>
cd gestion_creditos_backend
npm install
```

Crear el archivo `.env` en la raíz del proyecto:

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
JWT_SECRET=tu_secreto_interno_muy_largo
JWT_EXPIRES_IN=8h

# JWT — portal público (Cliente)
JWT_SECRET_CLIENT=tu_secreto_cliente_muy_largo
JWT_EXPIRES_IN_CLIENT=30m

# CORS
ALLOWED_ORIGINS=http://localhost:4200

# Zona horaria para cron jobs
TZ=America/Argentina/Buenos_Aires
```

Iniciar el servidor:

```bash
# Desarrollo (con hot reload)
npm run dev

# Producción
npm start
```

## Estructura del proyecto

```
src/
├── app.js                          # Punto de entrada, middlewares y rutas
├── config/
│   └── db.js                       # Pool de conexión PostgreSQL
├── jobs/
│   ├── overdueInstallments.job.js  # Cron: marca cuotas vencidas y aplica mora (02:00)
│   ├── creditExpiry.job.js         # Cron: expira créditos sin respuesta (03:00)
│   └── weeklyCommissionCycle.job.js# Cron: cierre de ciclo semanal (sáb 23:59)
├── middlewares/
│   ├── auth.middleware.js          # Verificación JWT y control de roles
│   └── validate.middleware.js      # Manejo de errores de express-validator
├── modules/
│   ├── auth/                       # Login, logout, cambio de contraseña
│   ├── users/                      # Gestión de usuarios internos
│   ├── customers/                  # Gestión de clientes
│   ├── products/                   # Catálogo y stock de productos
│   ├── credits/                    # Créditos (SALE y LOAN), simulador, aprobación
│   ├── installments/               # Cuotas, mora y condonación
│   ├── payments/                   # Pre-cargas de cobro y aprobación
│   ├── collections/                # Planillas de cobro diarias
│   ├── commissions/                # Comisiones, sueldos y liquidaciones
│   ├── cashRegister/               # Caja diaria y cierres
│   ├── reports/                    # Reportes de recaudación, mora, cartera y más
│   ├── interestRates/              # Matriz de tasas de interés
│   └── systemConfig/               # Parámetros configurables del sistema
└── utils/
    ├── creditCalculator.js         # Cálculo de cuotas, intereses y fechas de vencimiento
    ├── jwt.js                      # Firma y verificación de tokens
    ├── response.js                 # Respuestas HTTP estandarizadas
    ├── tempPassword.js             # Generador de contraseñas temporales
    ├── transaction.js              # Helper para transacciones PostgreSQL
    └── validators.js               # Reglas de validación por módulo
```

## Roles del sistema

| Rol | Descripción |
|---|---|
| `ADMIN` | Control total. Aprueba operaciones, gestiona usuarios, cierra caja, ejecuta liquidaciones. |
| `SELLER` | Registra clientes, genera pre-ventas y pre-préstamos, consulta comisiones propias. |
| `COLLECTOR` | Registra cobros en calle, consulta planillas asignadas, ve sus propios cobros. |
| `CLIENT` | Accede al portal público para ver su estado de cuenta (JWT separado, 30 min). |

## Referencia de endpoints

### Autenticación — `/api/auth`

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| POST | `/login` | Todos | Iniciar sesión |
| POST | `/logout` | Autenticado | Cerrar sesión (invalida token) |

### Usuarios — `/api/users`

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/` | ADMIN | Listar usuarios |
| GET | `/:id` | ADMIN | Obtener usuario por ID |
| POST | `/` | ADMIN | Crear usuario |
| PUT | `/:id` | ADMIN | Actualizar usuario |
| PATCH | `/:id/deactivate` | ADMIN | Desactivar usuario |
| PATCH | `/:id/reactivate` | ADMIN | Reactivar usuario |
| PATCH | `/:id/reset-password` | ADMIN | Resetear contraseña (genera temporal) |
| PATCH | `/me/change-password` | Autenticado | Cambiar contraseña propia |

### Clientes — `/api/customers`

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/` | ADMIN, SELLER, COLLECTOR | Listar clientes |
| GET | `/:id` | ADMIN, SELLER, COLLECTOR | Obtener cliente por ID |
| POST | `/` | ADMIN, SELLER | Crear cliente |
| PUT | `/:id` | ADMIN, SELLER | Actualizar cliente |
| PATCH | `/:id/deactivate` | ADMIN | Desactivar cliente |
| PATCH | `/:id/enable-portal` | ADMIN | Habilitar acceso al portal del cliente |

### Productos — `/api/products`

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/` | ADMIN, SELLER | Listar productos |
| GET | `/:id` | ADMIN, SELLER | Obtener producto por ID |
| POST | `/` | ADMIN | Crear producto |
| PUT | `/:id` | ADMIN | Actualizar producto |
| PATCH | `/:id/deactivate` | ADMIN | Desactivar producto |
| PATCH | `/:id/adjust-stock` | ADMIN | Ajustar stock manualmente |

### Tasas de interés — `/api/interest-rates`

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/` | ADMIN, SELLER | Listar tasas activas |
| GET | `/:id` | ADMIN | Obtener tasa por ID |
| POST | `/` | ADMIN | Crear combinación de tasa |
| PUT | `/:id` | ADMIN | Actualizar tasa |
| PATCH | `/:id/deactivate` | ADMIN | Desactivar combinación |
| PATCH | `/:id/activate` | ADMIN | Reactivar combinación |

### Créditos — `/api/credits`

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| POST | `/simulate` | Público (sin token) | Cotizador / simulador de cuotas |
| GET | `/` | ADMIN, SELLER, COLLECTOR | Listar créditos |
| GET | `/:id` | ADMIN, SELLER, COLLECTOR | Obtener crédito con cuotas |
| POST | `/` | ADMIN, SELLER | Crear pre-venta o pre-préstamo |
| PATCH | `/:id/approve` | ADMIN | Aprobar crédito → genera cuotas |
| PATCH | `/:id/reject` | ADMIN | Rechazar crédito |
| PATCH | `/:id/early-settlement` | ADMIN | Cancelación anticipada |

### Cuotas — `/api/installments`

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/` | ADMIN, SELLER, COLLECTOR | Listar cuotas (filtrar por `credit_id`) |
| GET | `/:id` | ADMIN, SELLER, COLLECTOR | Obtener cuota por ID |
| PATCH | `/:id/apply-penalty` | ADMIN | Aplicar mora (requiere estado OVERDUE) |
| PATCH | `/:id/waive-penalty` | ADMIN | Condonar mora |

### Cobros / Pagos — `/api/payments`

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/` | ADMIN, COLLECTOR | Listar cobros |
| GET | `/:id` | ADMIN, COLLECTOR | Obtener cobro por ID |
| POST | `/` | ADMIN, COLLECTOR | Registrar pre-carga de cobro |
| PATCH | `/:id/approve` | ADMIN | Aprobar cobro → actualiza cuota |
| PATCH | `/:id/reject` | ADMIN | Rechazar cobro |

### Planillas de cobro — `/api/collections`

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/` | ADMIN, COLLECTOR | Listar planillas |
| GET | `/:id` | ADMIN, COLLECTOR | Obtener planilla con detalle |
| POST | `/` | ADMIN | Generar planilla de cobro |

### Comisiones — `/api/commissions`

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/` | ADMIN, SELLER, COLLECTOR | Listar comisiones |
| GET | `/weekly-summary` | ADMIN | Resumen semanal para liquidación |
| GET | `/liquidations` | ADMIN, SELLER, COLLECTOR | Historial de liquidaciones |
| POST | `/liquidate` | ADMIN | Ejecutar liquidación semanal |
| GET | `/salary/:userId` | ADMIN | Ver sueldo fijo del cobrador |
| PUT | `/salary/:userId` | ADMIN | Configurar sueldo fijo |

### Caja — `/api/cash-register`

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/dashboard` | ADMIN | Dashboard de recaudación del día |
| GET | `/` | ADMIN | Historial de cierres |
| GET | `/:id` | ADMIN | Obtener cierre por ID |
| POST | `/close` | ADMIN | Ejecutar cierre de caja diario |

### Reportes — `/api/reports`

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/collection` | ADMIN | Recaudación por rango de fechas |
| GET | `/portfolio` | ADMIN | Estado de la cartera de créditos |
| GET | `/overdue` | ADMIN | Mora: cuotas vencidas por cliente |
| GET | `/collectors` | ADMIN | Efectividad por cobrador |
| GET | `/products` | ADMIN | Productos más vendidos y stock |

### Configuración del sistema — `/api/system-config`

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/` | ADMIN | Listar todos los parámetros |
| GET | `/:key` | ADMIN | Obtener parámetro por clave |
| PUT | `/:key` | ADMIN | Actualizar parámetro |
| POST | `/:key/reset` | ADMIN | Restaurar valor por defecto |

## Parámetros del sistema

| Clave | Descripción | Valor por defecto |
|---|---|---|
| `commission_rate` | Tasa de comisión por venta | `0.08` (8%) |
| `penalty_grace_days` | Días de gracia antes de mora | `3` |
| `penalty_rate_daily` | Porcentaje diario de mora | `0.005` (0.5%) |
| `penalty_max_rate` | Tope máximo de mora acumulable | `0.50` (50%) |
| `credit_expiry_days` | Días en PENDING antes de expirar | `7` |
| `min_credit_amount` | Monto mínimo en el cotizador | `1000` |
| `max_credit_amount` | Monto máximo en el cotizador | `500000` |
| `jwt_expiry_internal_hs` | Expiración JWT sistema interno | `8` |
| `jwt_expiry_portal_min` | Expiración JWT portal público | `30` |
| `login_max_attempts` | Intentos antes del bloqueo | `3` |
| `commission_week_close_day` | Día de cierre de ciclo (ISO) | `6` (sábado) |
| `commission_pay_day` | Día de liquidación (ISO) | `1` (lunes) |

## Tareas programadas (Cron Jobs)

| Job | Horario | Descripción |
|---|---|---|
| `overdueInstallments` | Todos los días 02:00 | Pasa cuotas a OVERDUE y aplica mora diaria |
| `creditExpiry` | Todos los días 03:00 | Expira créditos con más de N días sin respuesta |
| `weeklyCommissionCycle` | Sábados 23:59 | Cierra el ciclo semanal y genera log para liquidación del lunes |

## Flujo de negocio principal

```
Vendedor crea pre-venta/préstamo (PENDING_APPROVAL)
        ↓
Admin aprueba → crédito ACTIVE + cuotas generadas + stock descontado + comisión registrada
        ↓
Cobrador registra cobro en calle (payment PENDING)
        ↓
Admin aprueba cobro → cuota PAID/PARTIAL → crédito SETTLED si era la última
        ↓
Sábado: cierre del ciclo de comisiones
        ↓
Lunes: Admin ejecuta liquidación → comisiones PAID + egreso en caja
        ↓
Admin realiza cierre de caja diario
```

## Formato de respuestas

Todas las respuestas siguen la misma estructura:

```json
// Éxito
{
  "ok": true,
  "message": "Descripción de la operación",
  "data": { }
}

// Error
{
  "ok": false,
  "message": "Descripción del error",
  "errors": [ ]
}
```

## Migraciones de base de datos requeridas

```sql
-- Necesaria para invalidación de JWT al cambiar rol de usuario
ALTER TABLE users ADD COLUMN force_relogin_at TIMESTAMPTZ;

-- Necesaria para auditoría de movimientos de stock
CREATE TABLE stock_movements (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id           UUID NOT NULL REFERENCES products(id),
  movement             VARCHAR(3) NOT NULL CHECK (movement IN ('IN', 'OUT')),
  quantity             INT NOT NULL,
  reason               VARCHAR(255),
  available_stock_after INT NOT NULL,
  user_id              UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ DEFAULT NOW()
);
```
-------------------------------------------------------------------------------
# Módulo de Créditos — Documentación técnica

---

## Campos del crédito (`credits`)

### Campos que ingresa el usuario al crear

| Campo | Ejemplo | Descripción |
|---|---|---|
| `customer_id` | UUID | Cliente al que se le otorga el crédito |
| `type` | `LOAN` / `SALE` | `LOAN` = préstamo en efectivo · `SALE` = venta de productos |
| `total_amount` | `50000` | Monto del capital — lo que el cliente recibe/compra, sin intereses |
| `installments_count` | `6` | Cantidad de cuotas |
| `payment_frequency` | `MONTHLY` | Frecuencia: `WEEKLY` / `BIWEEKLY` / `MONTHLY` |
| `notes` | texto | Observaciones opcionales |
| `products[]` | array | Solo para `SALE` — productos con `product_id` y `quantity` |

---

### Campos que el sistema asigna al crear (antes de aprobar)

| Campo | Valor | Descripción |
|---|---|---|
| `status` | `PENDING_APPROVAL` | Estado inicial siempre |
| `interest_rate` | `null` | Se asigna recién al aprobar |
| `created_by` | ID del usuario | Quién generó la pre-venta/préstamo |
| `created_at` | timestamp | Cuándo se creó |

---

### Campos que el sistema asigna al aprobar

| Campo | Valor | Descripción |
|---|---|---|
| `status` | `ACTIVE` | Crédito activado |
| `interest_rate` | ej: `0.08` | Tasa leída de `interest_rates` según tipo + frecuencia + cuotas |
| `approved_by` | ID del Admin | Quién aprobó |
| `approved_at` | timestamp | Cuándo se aprobó |

---

## Cómo se calculan los montos

### Fórmula de la cuota

```js
// creditCalculator.js
const totalWithInterest  = totalAmount * (1 + interestRate);
const installmentAmount  = Math.ceil((totalWithInterest / installmentsCount) * 100) / 100;
```

> **Nota:** `Math.ceil` redondea hacia arriba para que la suma de cuotas nunca quede
> por debajo del total. El último centavo siempre paga el banco, no el cliente.

### Ejemplo concreto

Préstamo de **$50.000**, **6 cuotas mensuales**, tasa **8%**:

```
totalWithInterest = 50.000 × (1 + 0.08) = 54.000
installmentAmount = Math.ceil(54.000 / 6 × 100) / 100
                  = Math.ceil(9.000 × 100) / 100
                  = Math.ceil(900.000) / 100
                  = 9.000,00
```

---

## Campos de cada cuota (`installments`)

| Campo | Valor inicial | Descripción |
|---|---|---|
| `installment_number` | `1, 2, 3...` | Número de la cuota |
| `due_date` | calculado | Fecha de vencimiento |
| `amount_due` | `9000.00` | Lo que debe pagar en esa cuota (incluye mora si se aplica) |
| `amount_paid` | `0` | Lo que ya se pagó (se acumula con cobros parciales) |
| `penalty_amount` | `0` | Mora acumulada separada del capital |
| `status` | `PENDING` | Estado inicial |

---

## Cómo se calculan las fechas de vencimiento

```js
// creditCalculator.js
// La primera cuota vence 1 período después de la aprobación
for (let i = 1; i <= installmentsCount; i++) {
  switch (frequency) {
    case 'WEEKLY':   due = startDate + (7  * i) días;  break;
    case 'BIWEEKLY': due = startDate + (14 * i) días;  break;
    case 'MONTHLY':  due = startDate + i meses;         break;
  }
}
```

### Ejemplo

Crédito aprobado el **9 de abril**, **6 cuotas mensuales**:

| Cuota | Vencimiento |
|:---:|---|
| 1 | 9 de mayo |
| 2 | 9 de junio |
| 3 | 9 de julio |
| 4 | 9 de agosto |
| 5 | 9 de septiembre |
| 6 | 9 de octubre |