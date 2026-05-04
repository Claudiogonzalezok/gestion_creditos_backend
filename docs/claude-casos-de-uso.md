# Casos de uso — Resumen ejecutivo

Sistema de 16 casos de uso que cubren el ciclo completo:
alta de cliente → solicitud → aprobación → cuotas → cobranza → cierre.

## Índice

| CU | Nombre | Actores |
|----|--------|---------|
| CU01 | Autenticar usuario | Todos |
| CU02 | Gestionar usuarios y roles | Admin |
| CU03 | Gestionar clientes | Admin / Vendedor |
| CU04 | Gestionar productos | Admin / Vendedor (solo lectura) |
| CU05 | Generar pre-venta / pre-préstamo | Vendedor / Admin |
| CU06 | Ver estado de cuenta de clientes | Admin / Vendedor / Cobrador |
| CU07 | Registrar pre-carga de cobro | Cobrador / Admin |
| CU08 | Aprobar o rechazar pre-ventas y pre-préstamos | Admin |
| CU09 | Aprobar o rechazar pre-cargas de cobro | Admin |
| CU10 | Simular crédito / cotizador | Cliente / Vendedor / Admin (sin auth) |
| CU11 | Ver estado de cuenta propio | Cliente |
| CU12 | Gestionar caja y reportes | Admin |
| CU13 | Aplicar mora y cancelación anticipada | Admin |
| CU14 | Generar planilla de cobro | Admin / Cobrador |
| CU15 | Gestionar comisiones y liquidaciones | Admin / Vendedor / Cobrador |
| CU16 | Configuración de parámetros del sistema | Admin |

---

## CU01 — Autenticar usuario

**Flujo:** Login con DNI + contraseña → JWT según portal (interno: 8hs, cliente: 30min).
**Primer acceso:** Contraseña temporal → cambio obligatorio antes de operar.
**Bloqueo:** 3 intentos fallidos → Admin desbloquea manualmente.
**No hay recuperación automática:** el Admin resetea y comunica la nueva contraseña.
**JWT doble:** `sistema-interno` y `portal-cliente` son incompatibles entre sí.
**Cambio de rol:** invalida inmediatamente todos los tokens del usuario (`force_relogin_at`).

---

## CU02 — Gestionar usuarios y roles

**Solo Admin.** Crear, editar, desactivar (baja lógica), reactivar.
**Restricciones:**
- No se puede dejar el sistema sin un Admin activo.
- Cambiar rol invalida el token JWT del usuario afectado.
- Un Cobrador con clientes asignados no puede cambiar de rol.
- DNI único como identificador de negocio.

---

## CU03 — Gestionar clientes

**Admin y Vendedor** pueden crear y consultar.
**Solo Admin** puede desactivar.
**Restricciones:**
- No se puede desactivar un cliente con créditos ACTIVE o PENDING_APPROVAL.
- El Cobrador ve solo sus clientes asignados (`assigned_collector_id`), sin domicilio completo.
- Baja lógica; el historial se preserva.

---

## CU04 — Gestionar productos

**Admin:** crear, editar precio, ajustar stock manualmente, desactivar.
**Vendedor:** solo lectura del catálogo (nombre, precio, stock disponible).
**Restricciones:**
- No se puede desactivar un producto con créditos activos.
- El stock se descuenta al **aprobar** el crédito, no al crear la pre-venta.
- El `historical_price` se congela al crear la pre-venta; el `historical_rate` al aprobar.

---

## CU05 — Generar pre-venta / pre-préstamo

**SALE:** Vendedor selecciona productos con cantidad → sistema calcula total → pre-venta creada.
**LOAN:** Vendedor ingresa monto → Admin aprueba con tasa de `interest_rates`.
**Enganche (SALE):** Vendedor puede ingresar `down_payment` → reduce el capital.
**Cuotas prepagadas (SALE):** Vendedor puede indicar `prepaid_installments`.
**Estado inicial:** PENDING_APPROVAL. Stock no se descuenta hasta aprobar.
**Validaciones:** cliente activo, producto activo, stock disponible, tasa configurada.

---

## CU06 — Ver estado de cuenta de clientes

Solo lectura. Diferencia de vistas:
- **Admin / Vendedor:** datos completos, historial de créditos, resumen financiero.
- **Cobrador:** créditos activos + cuotas pendientes/vencidas. Sin domicilio, sin historial completo.

---

## CU07 — Registrar pre-carga de cobro

**Cobrador** registra el cobro físico → queda en PENDING.
Puede ser CASH o TRANSFER (con referencia bancaria).
No modifica la cuota hasta que el Admin apruebe.
Un mismo monto puede cubrir más de una cuota → el excedente se aplica automáticamente al aprobar.

---

## CU08 — Aprobar o rechazar pre-ventas y pre-préstamos

**Solo Admin.**

**Al aprobar SALE:**
1. Busca tasa en `product_rates` por (product_id, frequency, installments_count).
2. Congela `historical_rate` en `credit_products`.
3. Capital = total_amount - down_payment.
4. Genera cuotas (cronograma).
5. Si hay `prepaid_installments` → marca cuotas como PAID, registra `credit_down_payments` tipo PREPAID_INSTALLMENT, corre fechas.
6. Si hay `down_payment` → registra `credit_down_payments` tipo DOWN_PAYMENT.
7. Descuenta stock en `products.available_stock`.
8. Genera comisión (`total_amount × commission_rate`).

**Al aprobar LOAN:** Busca tasa en `interest_rates` por (frequency, installments_count, monto).

**Al rechazar:** PAYMENT en REJECTED, INSTALLMENT no cambia. Motivo obligatorio.

---

## CU09 — Aprobar o rechazar pre-cargas de cobro

**Solo Admin.**
**Al aprobar:**
- `amount_received >= amount_due` → cuota PAID.
- `amount_received < amount_due` → cuota PARTIAL.
- Si sobra saldo → aplica a cuotas siguientes automáticamente.
- Si se pagaron cuotas adicionales completas → corre fechas restantes.
- Si era la última cuota → crédito SETTLED.

**Al rechazar:** PAYMENT en REJECTED; INSTALLMENT no cambia. Motivo obligatorio.

---

## CU10 — Simular crédito / cotizador

**Sin autenticación** — único endpoint abierto de la API.
Para SALE: recibe `products[{product_id, quantity}]` → busca tasas en `product_rates`.
Para LOAN: recibe `total_amount` → busca tasa en `interest_rates`.
No persiste ningún dato. Resultados orientativos.

---

## CU11 — Ver estado de cuenta propio (portal cliente)

Cliente accede con DNI + contraseña. El Admin habilita el acceso previamente.
Solo lectura: deuda total, cuotas próximas a vencer, cronograma de créditos.
Sesión de 30 minutos de inactividad. Bloqueo tras 3 intentos fallidos.

---

## CU12 — Gestionar caja y reportes

**Solo Admin.**
Dashboard del día: cobros APPROVED + `credit_down_payments` + gastos - liquidaciones.
Cierre diario: declara efectivo → sistema calcula diferencia → registra inmutablemente.
Reportes: recaudación, cartera, mora, cobradores, productos, vencimientos próximos, resumen ejecutivo.

---

## CU13 — Aplicar mora y cancelación anticipada

**Mora:**
- Cron automático (02:00 hs): PENDING → OVERDUE tras días de gracia.
- Admin puede aplicar/condonar manualmente.
- `penalty_amount` y `amount_due` se actualizan en `installments`.

**Cancelación anticipada:**
- Admin ejecuta sobre un crédito ACTIVE.
- Calcula el saldo pendiente total → registra pago único → crédito SETTLED (EARLY_CANCELLATION).

---

## CU14 — Generar planilla de cobro

**Admin** genera para un Cobrador y fecha (filtros: TODAY / OVERDUE / TODAY_AND_OVERDUE / ALL_PENDING).
La planilla es informativa (snapshot), no modifica estados.
Si se regenera para el mismo cobrador y fecha, reemplaza la anterior.
Cada cobrador solo ve su propia planilla.

---

## CU15 — Gestionar comisiones y liquidaciones

**Generación automática:** al aprobar una venta SALE → `total_amount × commission_rate` → COMMISSION PENDING.
**Ciclo:** lunes a sábado. Cron cierra el ciclo los sábados 23:59.
**Liquidación (lunes):** Admin paga a cada empleado (comisiones + sueldo fijo si tiene).
Método: CASH o TRANSFER. Opera en transacción atómica.
Los registros de comisión nunca se eliminan; reversiones son registros negativos.

---

## CU16 — Configuración de parámetros del sistema

**Solo Admin.** Edita valores en `system_config`.
Validaciones cruzadas: `min_credit_amount` < `max_credit_amount`;
`commission_week_close_day` ≠ `commission_pay_day`.
Todo cambio queda auditado con el Admin que lo ejecutó y la fecha.
