# Contexto del Proyecto — Sistema de Gestión de Préstamos y Créditos

## ⚠️ INSTRUCCIONES DE CONTEXTO — LEER PRIMERO
- Leer **SOLO** los archivos mencionados explícitamente en cada prompt.
- **NO** indexar ni explorar el proyecto completo al iniciar sesión.
- **NO** leer directorios: `node_modules/`, `dist/`, `.angular/`, `coverage/`, `.git/`.
- **NO** leer archivos: `*.lock`, `*.log`, `*.map`, `package-lock.json`.
- Ante una tarea nueva: preguntar qué archivos son relevantes antes de explorar.
- Leer un archivo a la vez. No leer carpetas completas salvo que se indique.

---

## Stack tecnológico
- **Backend:** Node.js + Express · **BD:** PostgreSQL · **Auth:** JWT · **Arch:** MVC estricta
- **Frontend:** Angular + PrimeNG + Tailwind CSS

## Regla transversal Frontend (moneda)
- En formularios de monto con PrimeNG `p-inputNumber` y `mode="currency"`, usar siempre `appCurrencyAmountInput`.
- Objetivo: evitar el autocompletado fijo de `,00` que dificulta edición/borrado y mantener UX consistente en toda la app.
- Evitar `minFractionDigits="2"` en inputs monetarios editables por usuario (salvo requisito de negocio explícito).
- Referencia de implementación: `frontend/gestion-creditos-f/src/app/shared/directives/currency-amount-input.directive.ts`.

## Convenciones de código
- Comentarios en **español**. Documentación JSDoc en español justo sobre la firma:
  ```js
  /**
   * Descripción breve.
   * @param {Tipo} nombre - descripción (solo si no es obvio)
   * @returns {Tipo} descripción (solo si no es obvio)
   */
  ```
- **Nunca** descomentar bloques `/* ... */` o `/** ... */` existentes.
- Rutas → Controladores → Servicios → Queries. Sin lógica de negocio en rutas ni controladores.
- Validaciones de entrada solo en middleware. Manejo de errores centralizado.
- Credenciales siempre en `.env`, nunca hardcodeadas.

## Estructura de carpetas
```
src/
├── jobs/               # Cron jobs
├── modules/            # Un módulo por entidad: *.routes, *.controller, *.service, *.queries
├── middlewares/
│   ├── auth.middleware.js      # Verificación JWT + roles
│   └── validate.middleware.js  # express-validator
├── utils/
├── config/
│   └── db.js           # Pool PostgreSQL
└── app.js
```

## Roles del sistema
| Rol | Descripción |
|---|---|
| `ADMIN` | Control total. Único que aprueba operaciones y resetea contraseñas. |
| `SELLER` | Registra pre-ventas y pre-préstamos. |
| `COLLECTOR` | Registra pre-cargas de cobro. |
| `SELLER_COLLECTOR` | Ambos roles combinados. |
| `CLIENT` | Solo portal público (JWT separado, audience `portal-cliente`). |

## Reglas de negocio críticas

### Créditos
- Todo crédito nace en `PENDING_APPROVAL`. Solo el Admin aprueba.
- Tipos: `SALE` (venta producto) y `LOAN` (efectivo). Solo SALE genera comisión.
- Al aprobar SALE: buscar tasa en `product_rates` (por `product_id + frequency + installments_count`).
- Al aprobar LOAN: buscar tasa en `interest_rates` (por `frequency + installments_count + monto`).
- La tasa se congela en `credit_products.historical_rate` e `installments.original_amount` al aprobar.
- Stock: se descuenta al aprobar (no al crear). Unidades van `AVAILABLE → RESERVED → SOLD`.
- `down_payment` reduce el capital financiado pero **no** afecta la comisión (siempre sobre `total_amount`).

### Pagos y cobros
- Flujo doble control: Cobrador registra pre-carga (`PENDING`) → Admin aprueba → cuota pasa a `PAID`/`PARTIAL`.
- Si `amount_received` supera la cuota actual, el excedente se aplica a cuotas siguientes (adelanto).
- Al adelantar cuotas: marcarlas `PAID` con nota "Pago adelantado" y correr fechas de las restantes (guardar `original_due_date`).
- Si era la última cuota pendiente: crédito pasa a `SETTLED` automáticamente.

### Comisiones
- Solo ventas tipo SALE generan comisión: `total_amount × commission_rate` (default 8%).
- Se registra en la misma transacción atómica que aprueba el crédito.
- Ciclo semanal lunes-sábado. Liquidación el lunes por el Admin.
- Mora en un crédito SALE genera registro de comisión negativa (REVERSED), nunca se borra.

### Caja — Modelo Operativo V4
**Fuente de verdad arquitectónica:** `docs/cash-model-v4.md`. Resumen:

- **Jornada (`business_days`)** = día contable del negocio. Estados: `OPEN → READY_TO_CLOSE → CLOSED → AUDITED`. `READY_TO_CLOSE` es reversible (vuelve a OPEN si se abre una nueva caja). El cierre formal a CLOSED es manual.
- **Caja operativa (`cash_sessions`)** = turno operativo dentro de una jornada. **Una sola OPEN por jornada simultáneamente** (índice único parcial). Múltiples cajas secuenciales en el día (8-12, 16-22, 23-04) son válidas. `owner_user_id` representa al cajero responsable del turno, NO al dueño del dinero.
- **Cobradores NO administran cajas.** No abren, no cierran, no arquean. Solo registran pre-cargas. La pre-carga NO requiere caja abierta.
- **Imputación de movimientos:** todo cobro aprobado, gasto, conversión, enganche y reversión se imputa a la **caja activa de la jornada** (vía `cashSessions.queries.lockActiveSessionForCurrentJornada`). Si no hay caja activa → `409 NO_ACTIVE_SESSION`.
- **Aprobación = recepción del dinero.** No existe entidad de rendición ni `settled_at` — al aprobar una pre-carga, el dinero ya está en la empresa.
- **Caja General (`cash_accounts`)** = tesorería consolidada. Recibe drops, paga sueldos/comisiones/proveedores. `current_balance` cacheado con CHECK `>= 0` en DB.
- **Sueldos, comisiones, proveedores → SOLO Caja General** (vía endpoint público de `cash-accounts/:id/movements` o liquidate auto). Nunca caja operativa.
- **Legacy:** `cash_registers` y `cash_movements` están `@deprecated`. Se mantienen por compat hasta `feat/cash-system-cleanup`. No agregar lógica nueva sobre ellas.

### Configuración
- Parámetros del sistema en tabla `system_config` (leer siempre desde BD, no hardcodear).
- Función helper: `getValue(key)` en `systemConfig.queries.js`.

## Entidades principales
**Núcleo:** `users`, `customers`, `credits`, `products`, `product_variants`, `product_units`,
`credit_products`, `installments`, `payments`, `credit_down_payments`,
`collection_sheets`, `collection_sheet_details`,
`commissions`, `commission_liquidations`, `salaries`,
`interest_rates`, `product_rates`, `system_config`, `token_blacklist`.

**Caja V4:** `branches`, `business_days`, `cash_sessions`, `cash_session_drops`,
`cash_session_closure_details`, `cash_accounts`, `cash_account_movements`.

**Legacy (deprecated):** `cash_registers`, `cash_movements`. No agregar lógica nueva acá.

## Módulos actuales en `src/modules/`
`auth` · `users` · `customers` · `products` · `productBrands` · `productCategories` ·
`productVariants` · `productUnits` · `productRates` · `interestRates` · `credits` ·
`installments` · `payments` · `collections` · `commissions` · `businessDays` ·
`cashSessions` · `cashAccounts` · `cashRegister` (legacy) ·
`expenses` · `expenseCategories` · `reports` · `systemConfig` · `portal`

## Lo que NO hacer
- No mezclar lógica de negocio en rutas o controladores.
- No aprobar pagos sin el flujo de doble validación.
- No permitir que roles distintos de Admin accedan a aprobaciones o recuperación de contraseñas.
- No exponer datos sensibles innecesariamente en respuestas de API.
- No eliminar registros físicamente (siempre baja lógica: `status = 'INACTIVE'`/`'REJECTED'`).
- **No leer el proyecto completo al iniciar. Leer solo lo necesario.**

## Referencia completa
- Casos de uso: `docs/casos-de-uso.md`.
- **Modelo de Caja V4 (fuente de verdad arquitectónica):** `docs/cash-model-v4.md`.
- Plan de migración V4 (cómo se implementó): `docs/cash-model-v4-plan.md`.
- Auditoría legacy + plan de cleanup: `docs/audit-cash-legacy-2026-06-02.md`.
