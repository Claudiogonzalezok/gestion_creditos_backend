# Modelo de datos — Referencia de tablas y entidades

## 20 tablas (migración 001_create_tables.sql)

| # | Tabla | Descripción clave |
|---|-------|-------------------|
| 1 | `users` | Usuarios internos. Campos: `role`, `status`, `is_temp_password`, `force_relogin_at`, `locked_at`. |
| 2 | `customers` | Clientes. Campos portal: `portal_enabled`, `portal_password_hash`, `portal_locked_at`. Cobrador asignado: `assigned_collector_id`. |
| 3 | `products` | `description` (UNIQUE), `current_price`, `available_stock`, `category_id`, `status`. |
| 4 | `stock_movements` | `product_id`, `movement` (IN/OUT), `quantity`, `reason`, `user_id`. |
| 5 | `interest_rates` | Para LOAN. `payment_frequency`, `installments_count`, `min_amount`, `max_amount`, `rate`, `active`. |
| 6 | `product_rates` | Para SALE. `product_id`, `payment_frequency`, `installments_count`, `rate`, `active`. |
| 7 | `credits` | Crédito (SALE o LOAN). Ver campos clave abajo. |
| 8 | `credit_products` | `credit_id`, `product_id`, `quantity`, `historical_price`, `historical_rate`. |
| 9 | `installments` | `credit_id`, `installment_number`, `due_date`, `original_due_date`, `amount_due`, `amount_paid`, `penalty_amount`, `status`. |
| 10 | `payments` | Pre-cargas de cobro. `installment_id`, `collector_id`, `amount_received`, `payment_method`, `status` (PENDING/APPROVED/REJECTED). |
| 11 | `credit_down_payments` | Enganches y prepagos. `credit_id`, `payment_type` (DOWN_PAYMENT/PREPAID_INSTALLMENT), `amount`, `payment_method`. |
| 12 | `cash_registers` | Cierres diarios. `register_date` (UNIQUE), `total_collected`, `declared_cash`, `difference`, `difference_status`. |
| 13 | `collection_sheets` | `collector_id`, `sheet_date`, `filter_used`. UNIQUE por (date, collector). |
| 14 | `collection_sheet_details` | `sheet_id`, `installment_id`, `order_number`, `planned_amount`. |
| 15 | `token_blacklist` | `token_jti`, `user_id` o `customer_id`, `expires_at`. |
| 16 | `salaries` | `user_id`, `weekly_amount`, `active`. Solo para COLLECTOR/SELLER_COLLECTOR. |
| 17 | `commissions` | `user_id`, `credit_id`, `amount`, `status` (PENDING/PAID/REVERSED), `week_start`, `week_end`. |
| 18 | `commission_liquidations` | `user_id`, `week_start`, `week_end`, `commissions_total`, `salary_amount`, `total_paid`. |
| 19 | `expenses` | `amount`, `description`, `expense_date`, `payment_method`, `category_id`, `created_by`. |
| 20 | `system_config` | `key` (PK), `value` (string), `description`, `updated_by`. |

## Campos clave de `credits`

```
type                VARCHAR   SALE | LOAN
status              VARCHAR   PENDING_APPROVAL | ACTIVE | SETTLED | REJECTED | EXPIRED
total_amount        NUMERIC   Suma de historical_price de los productos
down_payment        NUMERIC   Enganche (solo SALE, default 0)
down_payment_method VARCHAR   CASH | TRANSFER
down_payment_transfer_reference VARCHAR  Referencia si fue transferencia
prepaid_installments SMALLINT Cuotas pagadas al firmar (solo SALE, default 0)
prepaid_installments_method VARCHAR  CASH | TRANSFER
interest_rate       NUMERIC   Coeficiente LOAN (NULL para SALE)
installments_count  SMALLINT  Cantidad de cuotas
payment_frequency   VARCHAR   WEEKLY | BIWEEKLY | MONTHLY
```

## Estados de `installments`

- `PENDING` — pendiente de cobro
- `PAID` — pagada
- `PARTIAL` — pago parcial recibido
- `OVERDUE` — vencida (pasó días de gracia)

## Parámetros configurables — `system_config`

| key | Descripción | Default |
|-----|-------------|---------|
| `commission_rate` | Tasa de comisión por venta (decimal) | 0.08 (8%) |
| `penalty_grace_days` | Días de gracia antes de mora | 3 |
| `penalty_rate_daily` | Porcentaje diario de mora | 0.005 (0.5%) |
| `penalty_max_rate` | Tope máximo de mora acumulable | 0.50 (50%) |
| `credit_expiry_days` | Días en PENDING antes de expirar | 7 |
| `min_credit_amount` | Monto mínimo en el cotizador | 1000 |
| `max_credit_amount` | Monto máximo en el cotizador | 500000 |
| `jwt_expiry_internal_hs` | Expiración JWT sistema interno (horas) | 8 |
| `jwt_expiry_portal_min` | Expiración JWT portal público (minutos) | 30 |
| `login_max_attempts` | Intentos fallidos antes del bloqueo | 3 |
| `commission_week_close_day` | Día de cierre del ciclo (ISO: 6=Sáb) | 6 |
| `commission_pay_day` | Día de pago de liquidaciones (ISO: 1=Lun) | 1 |

> Todos los valores son strings en BD; castear en código según el tipo.

## Cron jobs

| Job | Horario | Acción |
|-----|---------|--------|
| `overdueInstallments` | `0 2 * * *` | PENDING → OVERDUE + mora diaria |
| `creditExpiry` | `0 3 * * *` | Expira créditos PENDING_APPROVAL |
| `weeklyCommissionCycle` | `59 23 * * {closeDay}` | Cierre semanal (log) |
| `tokenCleanup` | `0 4 * * *` | Elimina tokens expirados de blacklist |

## Endpoints — referencia rápida

```
POST   /api/auth/login              /api/auth/portal/login
GET    /api/auth/me
POST   /api/users                   (Admin: DNI, full_name, email, role)
POST   /api/customers               (Admin/Seller: DNI, full_name, phone, address)
GET    /api/products                (Seller/Admin: catálogo con stock)
POST   /api/products                (Admin: description, current_price, available_stock)
PATCH  /api/products/:id/stock      (Admin: ajuste manual de stock)
GET    /api/product-rates?product_id=uuid
POST   /api/product-rates           (product_id, payment_frequency, installments_count, rate)
GET    /api/interest-rates
POST   /api/interest-rates          (payment_frequency, installments_count, min_amount, max_amount, rate)

POST   /api/credits/simulate        (sin token — cotizador público)
POST   /api/credits                 (SALE: products[{product_id,quantity}]; LOAN: total_amount)
PATCH  /api/credits/:id/approve
PATCH  /api/credits/:id/reject
PATCH  /api/credits/:id/early-settlement

POST   /api/payments                (pre-carga: installment_id, amount_received)
PATCH  /api/payments/:id/approve
PATCH  /api/payments/:id/reject

PATCH  /api/installments/:id/apply-penalty
PATCH  /api/installments/:id/waive-penalty
PATCH  /api/installments/:id/early-pay

POST   /api/collections             (planilla: collector_id, date, filter?)
POST   /api/commissions/liquidate   (user_id, payment_method)
GET    /api/commissions/weekly-summary

GET    /api/expenses
POST   /api/expenses
DELETE /api/expenses/:id

GET    /api/cash-register/dashboard
POST   /api/cash-register/close     (declared_cash, force?)

GET    /api/reports/summary | collection | portfolio | overdue | products | upcoming | collectors

GET    /api/portal/me | credits | credits/:id
```

## Body SALE (crear crédito)

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
  "prepaid_installments_method": "TRANSFER"
}
```

## Body cotizador SALE

```json
{
  "type": "SALE",
  "installments_count": 3,
  "payment_frequency": "MONTHLY",
  "products": [{ "product_id": "uuid", "quantity": 1 }],
  "down_payment": 30000
}
```
