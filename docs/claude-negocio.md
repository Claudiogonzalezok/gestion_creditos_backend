# Reglas de negocio y decisiones de diseño

## Tipos de crédito

| Aspecto | SALE | LOAN |
|---------|------|------|
| Tipo | Venta de productos | Préstamo en efectivo |
| Tasas | `product_rates` por `product_id` | `interest_rates` por rango de monto |
| `interest_rate` en credits | NULL | Valor del coeficiente |
| `historical_rate` en credit_products | Sí (congelado al aprobar) | N/A |
| Comisión | Sí (8% del total) | No |
| Enganche posible | Sí | No |
| Cuotas prepagadas | Sí | No |

## Modelo de productos

- `products` tiene: `description` (UNIQUE), `current_price`, `available_stock`, `category_id`, `status`.
- `credit_products` guarda `product_id`, `quantity`, `historical_price` y `historical_rate` (congelados al aprobar).
- El precio histórico se congela al **crear** la pre-venta; el `historical_rate` se congela al **aprobar**.
- El stock se descuenta automáticamente al **aprobar** el crédito, no al crearlo.
- No se puede desactivar un producto con créditos activos.

## Fórmula de cuotas

```javascript
// Redondea siempre hacia arriba al millar más cercano
cuota = Math.ceil(capital × (1 + rate) / n / 1000) × 1000
```

Para SALE con múltiples productos: se calcula por producto de forma proporcional
(`getProductInstallmentContribution`) y se suma. El `rate` de cada producto viene de
`product_rates`, buscado por `product_id + payment_frequency + installments_count`.

## Enganche (down_payment)

- El Vendedor lo ingresa al crear la pre-venta (opcional, solo SALE).
- `capital = total_amount - down_payment`.
- Al aprobar → registra en `credit_down_payments` tipo `DOWN_PAYMENT` (CASH o TRANSFER).
- El enganche **reduce el capital** pero **no la comisión** (comisión = `total_amount × 8%`).
- Impacta en caja directamente (no pasa por doble control de cobrador).

## Cuotas adelantadas al firmar (prepaid_installments)

- El Vendedor indica cuántas cuotas paga el cliente al momento de la venta (solo SALE).
- Al aprobar → marca esas cuotas como PAID, registra en `credit_down_payments` tipo `PREPAID_INSTALLMENT`.
- Corre las fechas restantes con `shiftInstallmentDates`.
- `original_due_date` guarda la fecha original para auditoría.

## Cobranzas: TODO va a pre-carga + aprobación del Admin (regla de negocio)

**Regla del dueño:** toda cobranza de cuotas se registra como *pre-carga* en estado
`PENDING` y recién impacta la caja cuando un **Admin la aprueba**
(`PATCH /payments/:id/approve`). No hay excepción por rol ni por tipo de cobro.

Aplica a **todas** las formas de cobrar una cuota:
- **Cobrador** cobra en la calle → crea pre-carga (`POST /payments`).
- **Admin** cobra una cuota → también crea pre-carga (`POST /payments`); **no** cobra directo.
- **Cancelación anticipada de crédito** (`PATCH /credits/:id/early-settlement`) → genera
  pre-carga(s) `PENDING` por el saldo a cancelar; el Admin las aprueba.

Consecuencias del diseño:
- Crear una pre-carga **no** mueve la caja y **no** requiere caja abierta (el cobrador es
  un actor de campo).
- El dinero entra a la caja **solo al aprobar**: ahí se exige caja operativa abierta y se
  imputa con desglose por medio (efectivo / transferencia).

> **Excepción — enganche y cuotas prepagas al firmar:** es la única "cobranza" que no pasa
> por pre-carga, porque se cobra *dentro de la aprobación del crédito por el Admin* (esa
> aprobación ya es el control). Va a `credit_down_payments`, no a `payments`. Ver secciones
> "Enganche" y "Cuotas adelantadas al firmar".

> **Pendiente (a definir con el equipo):** hoy la cancelación anticipada con N cuotas crea
> N pre-cargas (N aprobaciones). Está en evaluación unificarla en **una sola pre-carga** que,
> al aprobarse, salde todas las cuotas en una operación atómica (reutilizando la distribución
> de `_applyPaymentToInstallments`).

### Pago directo (existe pero NO se usa)

El backend tiene un camino de **cobro directo** que inserta el pago ya `APPROVED`,
**salteando** la pre-carga y la aprobación:
- `POST /payments/admin-direct` → `adminDirect` → `createApproved` (`admin_direct = TRUE`).
- `PATCH /installments/:id/early-pay` → delega en `adminDirect`.

**Estado actual: NO se usan.** El frontend cobra siempre por pre-carga + aprobación, en línea
con la regla de negocio. Se conservan a propósito como mecanismo disponible **por si en el
futuro se decide que el Admin —y solo el Admin— pueda cobrar de forma directa** (sin la doble
aprobación). Si esa decisión no se toma, lo recomendable es deprecar ambos endpoints para que
la regla quede impuesta por diseño y nadie pueda cobrar sin aprobación ni siquiera por API.

## Flujo de cobro con adelanto automático

Al aprobar un pago (`PATCH /payments/:id/approve`):
1. Aplica el monto a la cuota principal.
2. Si `amount_received` supera el saldo y la cuota quedó PAID, aplica el excedente a cuotas siguientes en orden.
3. Cuota cubierta completa → PAID con nota "Pago adelantado".
4. Cuota cubierta parcial → PARTIAL.
5. Si se pagaron cuotas adicionales completas (`paidCount > 0`) → corre fechas con `shiftInstallmentDates`.
6. Verifica si el crédito quedó totalmente liquidado → SETTLED.

## Diferencia entre tablas de tasas

| Aspecto | `interest_rates` | `product_rates` |
|---------|-----------------|-----------------|
| Aplica a | LOAN | SALE |
| Filtro de monto | Sí (min/max_amount) | No |
| Lookup al aprobar | Por frecuencia + cuotas + monto | Por product_id + frecuencia + cuotas |

## `credit_down_payments` — separado de `payments`

Los enganches y las cuotas prepagadas **no van a la tabla `payments`**.
Van a `credit_down_payments` con `payment_type`:
- `DOWN_PAYMENT` — enganche al crear la venta
- `PREPAID_INSTALLMENT` — cuotas adelantadas al crear la venta

Ambos impactan en caja directamente sin necesitar aprobación del Admin.

## Cierre de caja

```
Total recaudado = cobros APPROVED + enganches + cuotas prepagadas (credit_down_payments)
Total egresos   = liquidaciones de comisiones + gastos del día (expenses)
Diferencia      = declared_cash - cash_amount (efectivo)
```

- Solo un cierre por día; es inmutable.
- Si hay pre-cargas PENDING → devuelve 409. Se puede forzar con `force: true`.
- El cierre vincula automáticamente las liquidaciones del día.

## Comisiones

- Solo para créditos SALE, al aprobar.
- Monto: `total_amount × commission_rate` (configurable en `system_config`, default 8%).
- Se acumulan en la tabla `commissions` con estado PENDING.
- Ciclo semanal: lunes a sábado. Cron job cierra el ciclo los sábados a las 23:59.
- Liquidación: los lunes, el Admin paga a cada empleado su total neto (comisiones + sueldo fijo si tiene).
- Nunca se eliminan registros de comisión; las reversiones son registros negativos.

## Mora

- Cron job diario (02:00 hs): PENDING → OVERDUE cuando venció + días de gracia configurados.
- Tasa diaria configurable (`penalty_rate_daily`, default 0.5%).
- Tope máximo configurable (`penalty_max_rate`, default 50% del monto original).
- El Admin puede aplicar o condonar mora manualmente.
- `penalty_amount` y `amount_due` se actualizan en `installments`.

## Autenticación JWT doble

- Sistema interno: `JWT_SECRET_INTERNAL`, audiencia `sistema-interno`, expira 8 hs.
- Portal cliente: `JWT_SECRET_PORTAL`, audiencia `portal-cliente`, expira 30 min.
- Blacklist en `token_blacklist` — cron job limpia tokens expirados (04:00 hs).
- `force_relogin_at` en `users` invalida tokens emitidos antes del cambio de rol.
- Contraseña temporal: `is_temp_password = true` bloquea todos los endpoints salvo `/me/change-password`.

## Reglas de seguridad de acceso

- Admin es el único que puede resetear contraseñas y desbloquear cuentas.
- Bloqueo tras 3 intentos fallidos (configurable en `system_config`).
- No existe recuperación automática por email — todo pasa por el Admin.
- El Admin no puede desactivarse si es el único Admin activo.
- Un Cobrador con clientes asignados no puede cambiar de rol.

## Planillas de cobro

- El Admin genera la planilla para un Cobrador y una fecha.
- La planilla incluye cuotas PENDING, OVERDUE y PARTIAL según el filtro elegido.
- No modifica estados — es informativa (snapshot del momento).
- Si se regenera para el mismo cobrador y fecha, reemplaza la anterior.
- Cada cobrador solo ve su propia planilla.
