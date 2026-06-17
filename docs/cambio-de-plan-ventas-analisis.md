# Cambio de Plan en créditos de VENTA (SALE) — Análisis

> Estado: **ANÁLISIS / DISEÑO. No implementado.** Extiende el cambio de plan
> (hoy solo LOAN, ver `cambio-de-plan-analisis.md`) a créditos SALE.
> Rama de trabajo: `feat/cambio-de-plan-ventas`.

## 0. Regla de negocio clave: 1 crédito = 1 producto
**Un crédito de venta tiene UN solo producto.** No puede tener más de uno; si el
cliente quiere otro producto, se genera **otro crédito**. (Nota: el código actual
*permite* cargar varios productos en un crédito — es una divergencia con la regla,
ver §8.)

Esto simplifica todo: como hay **un único producto**, hay **una única tasa** (la de
ese producto). El cambio de plan en SALE es entonces **casi idéntico a LOAN**: solo
cambia **de dónde sale la tasa** y que hay que actualizar el `historical_rate` del
producto.

### Cómo se arma hoy una venta (con 1 producto)
- `capital (financiado) = total_amount − down_payment`.
- `tasa = product_rates(product_id, frecuencia, installments_count)` — congelada en `credit_products.historical_rate`.
- `cuota = getInstallmentAmount(capital, tasa, installments_count)`; total = cuota × count.

La regla del cambio de plan es la misma que LOAN: **`nuevo_plan = cuotas_pagadas + 1`**, una sola cuota viva, fechas originales, saldo ≤ 0 cancela, un solo cambio, etc.

---

## 1. Cálculo del nuevo total (igual que LOAN, con tasa de product_rates)
```
nueva_tasa  = product_rates(product_id, frecuencia, pagadas+1)
nuevo_total = capital × (1 + nueva_tasa)
nuevo_saldo = nuevo_total − total_pagado
```
Es la misma Opción A validada para LOAN; la única diferencia es que la tasa se busca
en `product_rates` (por producto) en lugar de `interest_rates`. **Hay una sola tasa**,
así que no existe el problema de "tasa combinada" que se planteaba con multi-producto.

- **Tasa a mostrar en la UI:** la tasa del producto, directo (`currentPlan.rate` =
  tasa original del producto ×100; `newPlan.rate` = nueva tasa ×100). Sin promedios
  ni desgloses — hay un único valor.

---

## 2. Impacto en la ejecución (qué se actualiza)
Igual que LOAN (cuota sobreviviente recalculada / futuras `PLAN_CHANGE_CANCELLED` /
saldo ≤ 0 cancela el crédito), **más**:
- `credits.installments_count` → `pagadas+1` (ya lo hace `updateCreditPlanColumns`).
  Arregla también el label "Cuota X de N" de la planilla para SALE.
- **`credit_products.historical_rate` → la nueva tasa del producto** (1 sola fila).
  Es el único agregado real respecto de LOAN.
- `credits.interest_rate` → **sigue NULL en SALE** (el detalle muestra "N/A (Venta)"). No se toca.
- `total_amount` (precio de venta) **no cambia**.

---

## 3. Edge cases
- **Falta `product_rate` para `pagadas+1`** → cambio inválido (422 con el nombre del producto, como en la aprobación).
- **Down payment / cuotas prepagas:** ya reflejados en el capital financiado y en `total_pagado` (Σ amount_paid). Sin tratamiento extra.
- **Comisión:** se calculó sobre `total_amount` al aprobar; **no se recalcula** (el cambio de plan no toca comisiones). Confirmar.
- **Crédito SALE con >1 producto (dato legacy/anomalía):** contradice la regla. Diseño defensivo: si un crédito SALE tiene más de un `credit_product`, **rechazar el cambio de plan** con mensaje claro ("crédito con múltiples productos, no elegible"), en vez de inventar una recombinación. Así no dependemos de un caso que no debería existir.

---

## 4. Reutilización de código
- `prQueries.findActiveRate(product_id, frecuencia, count)` — tasa del producto.
- `findCreditUnits(creditId)` — devuelve el `product_id` del crédito (para el lookup).
- `getFinancedAmount`, `getInstallmentAmount` — ya existen.
- Todo el flujo de cambio de plan LOAN (`_resolvePlanChange`, `changePlan`, anulación de cuotas, `credit_plan_changes`, guard de un solo cambio, `updateCreditPlanColumns`) se reutiliza; cambios mínimos:
  1. En `_resolvePlanChange`, según `credit.type`: LOAN usa `irQueries.findActiveRate(freq, count, capital)`; SALE usa `prQueries.findActiveRate(product_id, freq, count)`.
  2. En la ejecución, para SALE actualizar `credit_products.historical_rate`.

---

## 5. Cambios backend
1. `_resolvePlanChange`: quitar el rechazo `type !== 'LOAN'` y bifurcar SOLO el
   lookup de tasa (LOAN → interest_rates; SALE → product_rates del único producto).
   Validar 1 producto (rechazar si hay varios).
2. Ejecución (`changePlan`): para SALE, `updateCreditProductHistoricalRate(creditId, nuevaTasa)`.
3. Auditoría `credit_plan_changes`: `original_rate`/`new_rate` = tasa del producto (un solo valor, igual que LOAN).
4. Habilitar SALE en el endpoint (hoy devuelve 422 para SALE).
5. Tests unit + integración SALE (incl. falta de tasa para el nuevo conteo).

## 6. Cambios frontend
- El botón "Cambiar plan" hoy solo aparece para `credit.type === 'LOAN'`. **Habilitarlo también para SALE** (ACTIVE, admin).
- El diálogo ya muestra `rate`/total/saldo — sirve sin cambios (tasa = la del producto).

## 7. Riesgos
- **Cobertura de `product_rates`:** si los planes cortos no tienen tasa para el producto, ese crédito no será elegible. Verificar.
- **`credit_products.historical_rate`:** actualizarla cambia lo que ven reportes históricos del crédito; el original queda en `credit_plan_changes`. Confirmar.

## 8. Aparte (no bloqueante): la regla "1 producto por crédito" no está forzada
El backend **permite** crear créditos SALE con varios productos, contra la regla de
negocio. Esto es independiente del cambio de plan, pero conviene anotarlo: convendría
**validar al crear/aprobar** que un crédito SALE tenga exactamente un producto.
¿Querés que lo encare como un fix aparte?

---

## 9. Decisión de negocio requerida
1. **Confirmar** el cálculo: nueva tasa = `product_rates(producto, frecuencia, pagadas+1)`, `nuevo_total = capital × (1 + nueva_tasa)` (Opción A, igual que LOAN). 
2. ¿La **comisión** queda intacta? (recomendado sí).
3. Crédito SALE con >1 producto (legacy): ¿**rechazar** el cambio (recomendado) o pedir otra cosa?

Con esto definido, la implementación es chica: reutiliza casi todo LOAN.
