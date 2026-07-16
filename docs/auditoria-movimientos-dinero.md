# Auditoría — Movimientos de dinero: registro y visibilidad

> **Disparador:** se registró un **ingreso manual directo a Caja General** y no
> se encontró dónde consultarlo. Esta auditoría releva TODOS los movimientos de
> dinero del sistema (ingresos y egresos, caja operativa y tesorería), dónde se
> registra cada uno, **dónde se ve en la UI**, y su enlace con dashboard y
> reportes. Solo auditoría — sin cambios de código. Evidencia con
> `archivo:línea` sobre main (back y front) al 2026-07-15.

---

## 1. Respuesta directa al caso disparador

**El ingreso manual a Caja General SÍ quedó registrado y SÍ tiene dónde verse:**

📍 **Reportes → pestaña "Movimientos de caja" → selector de alcance "Caja
General" → elegir rango de fechas.**

Ahí aparece el ledger completo de tesorería con tipo **"Ingreso manual"**,
monto, desglose efectivo/transferencia, concepto y quién lo registró
(`reports/general-cash-movements`, tab con scope `GENERAL` en
`cash-movements-report.component.ts:96,153`).

**Por qué costó encontrarlo (el problema real es de visibilidad, no de
registro):**
1. Se registra desde la pantalla **Caja** (diálogo "Ingreso manual" con destino
   COMPANY → `cash-register.component.ts:578`), pero esa misma pantalla **no
   tiene historial de Caja General** — solo muestra el saldo. Lo natural es
   buscarlo donde se cargó, y ahí no está.
2. En Reportes está detrás de **dos niveles**: la pestaña "Movimientos de caja"
   + un toggle de alcance que arranca en "Caja x Jornada" (default
   `JORNADA`, `cash-movements-report.component.ts:96`).
3. El **dashboard no tiene ninguna señal de tesorería** (ver §4).

---

## 2. Mapa completo — Caja operativa (`cash_sessions`)

Todo movimiento operativo se imputa a la **caja activa de la jornada**.

| Movimiento | Dir. | Se origina en | Dónde se VE |
|---|---|---|---|
| Cobro de cuota aprobado (incl. adelantos y venta de contado) | IN | Aprobación de pre-carga / venta | Caja (movimientos de la sesión) · Cobros · Reportes→Mov. de caja (Jornada) · Dashboard ("Recaudación de la jornada") |
| Enganche (down payment) | IN | Aprobación del crédito | Ídem anterior |
| Cuotas prepagas al aprobar | IN | Aprobación del crédito | Ídem |
| **Ingreso manual a la caja de la jornada** (destino ≠ COMPANY) | IN | Caja → diálogo "Ingreso manual" (`cash-register.component.ts:584`) | Caja (movimientos) · Reportes (Jornada) |
| Gasto imputado a caja | OUT | Gastos (source caja) | Caja · Gastos · Reportes (Jornada) |
| Conversión de caja | OUT/± | Caja → conversiones | Caja · Reportes→Conversiones |
| Desembolso de préstamo (LOAN) | OUT | Aprobación del LOAN (migración 044) | Caja (egresos) · afecta cierre |
| Reversión de cobro | OUT | Anulación de pago aprobado | Caja · Cobros · Reportes (Jornada) |
| Drop al cierre → Caja General | OUT | Cierre de caja | Caja (cierre) · aparece como `DROP_IN` en tesorería |

**Cobertura: COMPLETA.** Cada movimiento de caja operativa es visible en la
pantalla Caja, en Reportes (alcance Jornada) y los ingresos por cobro
alimentan el dashboard. Sin brechas detectadas en este nivel.

## 3. Mapa completo — Caja General / Tesorería (`cash_account_movements`)

Libro contable independiente de jornadas (`025_cash_accounts.sql:59`,
ampliado por `038` con MANUAL_INCOME). Tipos y origen:

| Movimiento | Dir. | Se origina en | Dónde se VE |
|---|---|---|---|
| `DROP_IN` (dinero del cierre de caja) | IN | Cierre de caja operativa | ✅ Reportes→Mov. de caja→**Caja General** |
| **`MANUAL_INCOME` (ingreso manual directo)** | IN | Caja → "Ingreso manual" destino COMPANY (`POST cash-accounts/:id/movements`) | ✅ Solo Reportes→**Caja General** ← *el caso disparador* |
| `SALARY_PAYMENT` (sueldos + liquidación de comisiones) | OUT | Caja → pago de sueldo / liquidación auto | ✅ Reportes→Caja General · Liquidaciones |
| `SUPPLIER_PAYMENT` | OUT | Caja → pago a proveedor | ✅ Reportes→Caja General |
| `EXPENSE` (gasto de empresa) | OUT | Gastos (source COMPANY) | ✅ Reportes→Caja General · Gastos |
| `ADJUSTMENT` | IN/OUT | Ajuste administrativo | ✅ Reportes→Caja General |

**Saldo (`current_balance`):** visible en la pantalla Caja
(`cash-register.component.ts:120,847` → `GET cash-accounts`). Cacheado con
CHECK `>= 0` en BD; existe endpoint de contraste saldo-vs-movimientos
(`GET cash-accounts/:id/audit-balance`) **sin consumir desde la UI** —
herramienta disponible para el equipo vía API.

**Cobertura: registrada al 100%, visible SOLO en un lugar.** Todos los tipos
tienen label correcto en el reporte (incl. "Ingreso manual",
`cash-movements-report.component.ts:38-43`), pero el único punto de consulta
es ese tab+toggle de Reportes.

## 4. Enlace con Dashboard y Reportes

| Superficie | Caja operativa | Caja General |
|---|---|---|
| **Dashboard admin** | ✅ "Recaudación de la jornada" (ligada a la caja abierta) | ❌ **Nada**: ni saldo, ni ingresos/egresos de tesorería |
| **Reportes → Movimientos de caja** | ✅ alcance "Caja x Jornada" (default) | ✅ alcance "Caja General" (rango de fechas) |
| **Reportes → Cajas / Conversiones / Recaudación / Resumen** | ✅ | ❌ (por diseño, son reportes operativos) |
| **Pantalla Caja** | ✅ lista de movimientos de la sesión | ⚠️ **Solo el saldo** — sin historial |

## 5. Brechas detectadas (por severidad)

| # | Brecha | Severidad | Detalle |
|---|---|---|---|
| **B1** | **Caja General sin historial en la pantalla Caja** | **Media** — es la causa del caso disparador | El endpoint `GET cash-accounts/:id/movements` (con filtros por tipo/dirección/fecha y paginado, `cashAccounts.routes.js:36-52`) **existe y nadie lo consume**. Se registra dinero desde Caja pero para verlo hay que saber ir a Reportes → tab → toggle. |
| **B2** | Dashboard sin señal de tesorería | Baja/Media | El dashboard muestra solo recaudación operativa de la jornada. El dueño no tiene a simple vista el saldo de Caja General ni los movimientos del día de tesorería (ej. este ingreso manual no movió ningún número del dashboard). |
| **B3** | Descubribilidad del ledger de tesorería | Baja | Default del toggle en "Caja x Jornada"; nada en la pantalla Caja enlaza al reporte de Caja General. |
| **B4** | `audit-balance` sin superficie | Baja | El contraste saldo cacheado vs suma de movimientos existe solo vía API. Útil ante sospecha de descuadre; hoy requiere curl/Postman. |

**No se detectaron fugas de registro**: todos los ingresos y egresos, en ambos
niveles, escriben en su tabla correspondiente dentro de la transacción del
caso de uso (verificado a nivel código). El problema es exclusivamente de
**superficie de consulta**.

## 6. Recomendaciones (para discutir con el equipo — ninguna implementada)

1. **[B1, bajo costo — recomendada]** En la pantalla Caja, junto al saldo de
   Caja General, un botón **"Ver movimientos"** que abra el historial:
   opción (a) navegar a Reportes → Movimientos de caja con
   `scope=GENERAL` preseleccionado por query param (el tab ya soporta
   restaurar contexto por query params, `cash-movements-report.component.ts:392`);
   opción (b) panel propio consumiendo el `GET cash-accounts/:id/movements`
   ya existente. La (a) es casi gratis.
2. **[B2, costo medio]** Card de tesorería en el dashboard: saldo de Caja
   General + IN/OUT del día (datos ya disponibles vía `GET cash-accounts` y
   el reporte general con from=to=hoy). Decisión de producto más que técnica.
3. **[B3, gratis]** Al registrar un ingreso manual COMPANY, que el toast de
   éxito diga dónde consultarlo ("Registrado en Caja General — ver en
   Reportes → Movimientos de caja → Caja General").
4. **[B4, opcional]** Botón "Auditar saldo" (admin) que consuma
   `audit-balance` y muestre cacheado vs derivado.

## 7. Guía rápida de consulta (estado actual, para el equipo)

| Quiero ver… | Dónde |
|---|---|
| Movimientos de la caja de HOY | Caja (pantalla) o Reportes→Mov. de caja→Caja x Jornada |
| Un ingreso manual a tesorería | **Reportes→Mov. de caja→Caja General + rango de fechas** |
| Sueldos/comisiones/proveedores pagados | Reportes→Caja General (tipos Pago de sueldo / Pago a proveedor) |
| Saldo de tesorería | Pantalla Caja (card Caja General) |
| Qué entró a tesorería desde cierres de caja | Reportes→Caja General (tipo Drop) |
| Recaudación de la jornada | Dashboard / Reportes→Recaudación |
