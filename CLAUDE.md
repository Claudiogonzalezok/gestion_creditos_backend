# Contexto del Proyecto — Sistema de Gestión de Préstamos y Créditos

## Stack tecnológico
- **Backend:** Node.js + Express · **BD:** PostgreSQL · **Auth:** JWT · **Arch:** MVC estricta

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

### Caja
- Un cierre por día (`cash_registers`). Inmutable una vez registrado.
- Incluye: cobros aprobados + enganches (`DOWN_PAYMENT`) + adelantos de cuotas prepagados.

### Configuración
- Parámetros del sistema en tabla `system_config` (leer siempre desde BD, no hardcodear).
- Función helper: `getValue(key)` en `systemConfig.queries.js`.

## Entidades principales (16)
`users`, `customers`, `credits`, `products`, `product_variants`, `product_units`,
`credit_products`, `installments`, `payments`, `credit_down_payments`,
`cash_registers`, `collection_sheets`, `collection_sheet_details`,
`commissions`, `commission_liquidations`, `salaries`,
`interest_rates`, `product_rates`, `system_config`, `token_blacklist`

## Módulos actuales en `src/modules/`
`auth` · `users` · `customers` · `products` · `productBrands` · `productCategories` ·
`productVariants` · `productUnits` · `productRates` · `interestRates` · `credits` ·
`installments` · `payments` · `collections` · `commissions` · `cashRegister` ·
`expenses` · `expenseCategories` · `reports` · `systemConfig` · `portal`

## Lo que NO hacer
- No mezclar lógica de negocio en rutas o controladores.
- No aprobar pagos sin el flujo de doble validación.
- No permitir que roles distintos de Admin accedan a aprobaciones o recuperación de contraseñas.
- No exponer datos sensibles innecesariamente en respuestas de API.
- No eliminar registros físicamente (siempre baja lógica: `status = 'INACTIVE'`/`'REJECTED'`).

## Referencia completa
Ver `docs/casos-de-uso.md` para especificaciones detalladas de los 16 casos de uso y el DER.
