# Cambio de Plan de Crédito — Análisis técnico y diseño

> Estado: **DISEÑO FINAL. Definiciones de negocio CERRADAS** (`cambio-de-plan.md` líneas
> 290–529). Todavía **no** se implementa código. Próximo paso: ejecutar el plan por etapas.

## 0. Resumen ejecutivo

"Cambio de plan" = recalcular el saldo pendiente de un crédito ACTIVE usando la **tasa de un
plan más corto**, dejando **una única cuota viva** (la siguiente a la última pagada), que
conserva su fecha original. **No** es refinanciación: no se crea un crédito nuevo, no se genera
un calendario nuevo, no se mueven vencimientos ni se crean cuotas.

### Definiciones cerradas por negocio (base del diseño)
1. **Plan destino determinístico:** `nuevo_plan = cuotas_pagadas + 1`. El sistema lo calcula;
   el usuario **no** elige. (No es un dropdown libre.)
2. **Fórmula (Opción A, validada):** `nuevo_total = capital + interés_del_nuevo_plan`;
   `nuevo_saldo = nuevo_total − total_pagado`. La cuota sobreviviente queda en `nuevo_saldo`.
3. **La reducción de interés es intencional**, no un error de cálculo.
4. **Cuotas pagadas:** jamás se tocan ni recalculan; pagos históricos intactos.
5. **Cuotas futuras (posteriores a la sobreviviente):** se anulan con un **estado propio**
   de cambio de plan. **Prohibido reutilizar `REFINANCED`.**
6. **Fechas:** la cuota sobreviviente conserva su `due_date` original; sin nuevos calendarios.
7. **`nuevo_saldo ≤ 0`:** el crédito queda **cancelado automáticamente** (sin cuota a cobrar).
8. **Alcance V1:** solo **LOAN**. SALE excluido.
9. **Sin reversión en V1:** el cambio es definitivo (diseñar como tal).
10. **Auditoría obligatoria:** plan/tasa original, plan/tasa nuevo, saldo anterior y
    recalculado, fecha y usuario.

### Diseño elegido (consecuencia de lo anterior)
- **Impacto en cuotas → Alternativa 1:** modificar la cuota viva sobreviviente y anular las
  futuras con el nuevo estado. Única coherente con "no crear cuotas / no mover fechas".
- **Nuevo estado de cuota:** `PLAN_CHANGE_CANCELLED` (ver §4).
- **Trazabilidad → tabla nueva `credit_plan_changes`** (espejo de `credit_refinancings`).
- **`settlement_type` nuevo:** `PLAN_CHANGE` para el crédito que se liquida por esta vía.

---

## 1. Auditoría del sistema actual

### 1.1 Dónde vive cada cosa

| Concepto | Ubicación | Notas |
|---|---|---|
| Plan (cuotas + frecuencia) | `credits.installments_count`, `credits.payment_frequency` | Se congelan al aprobar (`credits.queries.js` activar crédito). |
| Tasa (LOAN) | `credits.interest_rate` | Coeficiente congelado al aprobar. |
| Tasa (SALE) | `credit_products.historical_rate` | **Por producto**, no hay una tasa única del crédito. |
| Capital financiado | `getFinancedAmount(total_amount, down_payment)` = `total_amount − down_payment` | `credits.service.js:33`. LOAN: down=0. |
| Cuotas | tabla `installments` | Cuotas planas iguales; `original_amount = amount_due` al generar. |
| Saldo pendiente | `getTotalPendingBalance(creditId)` | Σ(`amount_due − amount_paid`) de cuotas NOT IN (`PAID`,`REFINANCED`) − pre-cargas PENDING. |
| Pagado | Σ `installments.amount_paid` | Caja nominal recibida. |

### 1.2 Motor de cálculo (reutilizable) — `src/utils/creditCalculator.js`
- `getInstallmentAmount(capital, coef, count)` = `ceil(round(capital·(1+coef)/count)/1000)·1000` (cuota redondeada al millar superior).
- `getTotalWithInterest(capital, coef)` = `capital·(1+coef)` (total matemático, **sin** redondeo por cuota).
- `getTotalToReturn(capital, coef, count)` = cuota redondeada × count.
- `getDueDatesFromFirstPayment(...)`, `addFrequencyPeriods(...)` para fechas (no se usan en cambio de plan, pero existen).

### 1.3 Lookup de tasa por plan (reutilizable)
- LOAN: `interestRates.queries.findActiveRate(frequency, count, amount)` → fila con `.rate`.
- SALE: `productRates.queries.findActiveRate(product_id, frequency, count)`.
- Es exactamente lo que usa `simulate()` (`credits.service.js:402`) y `approve()`.

### 1.4 Cuotas: estados y generación
- Estados de `installments`: `PENDING`, `PARTIAL`, `OVERDUE`, `PAID`, `REFINANCED`.
- `getTotalPendingBalance` y `countPendingInstallments` **excluyen** `PAID` y `REFINANCED`.
- `generateInstallments` (`credits.queries.js:243`) inserta `amount_due = original_amount = installmentAmount` y `due_date` por calendario. Cuota plana.

### 1.5 Refinanciación existente (patrón a espejar, NO a reutilizar tal cual)
`refinance()` (`credits.service.js:1080`): bajo transacción con `FOR UPDATE`, valida estado/saldo/pre-cargas, **crea un crédito LOAN nuevo** (`PENDING_APPROVAL`) que absorbe el saldo, marca el original `REFINANCED`, y registra en `credit_refinancings` (migración `009`).

**Diferencias clave con cambio de plan:**

| | Refinanciación | Cambio de plan |
|---|---|---|
| Crédito nuevo | Sí | **No** |
| Calendario nuevo | Sí (nuevas fechas) | **No** (conserva fechas) |
| Cuotas nuevas | Sí | **No** (reusa la cuota viva) |
| Objetivo | Reestructurar (más cuotas / aliviar) | Re-tasar a plan más corto y cancelar |
| Aprobación | Crea PENDING_APPROVAL → approve | A definir (ver §9) |

De refinanciación **sí** reutilizamos: el **patrón de tabla de auditoría**, los locks `FOR UPDATE`, y los guards (estado ACTIVE, sin pre-cargas PENDING).

---

## 2. Interpretación de la regla de negocio

### 2.1 La restricción "una única cuota viva" es determinística
Sea `pagadas` = cantidad de cuotas totalmente `PAID`. El cambio solo es válido al plan de
**`nuevo_count = pagadas + 1`** cuotas, porque ese es el único que deja exactamente una cuota
viva (la `pagadas+1`). Cualquier otro plan deja 0 o varias → inválido.

- 12 cuotas, 3 pagadas → único plan válido = **4** (cuota 4 sobrevive). ✓ (ejemplo del doc)
- 12 cuotas, 3 pagadas → plan 6 = inválido (quedarían varias). ✓
- 6 cuotas, 2 pagadas → plan **3**. ✓ (ejemplo del doc)

> **Implicancia de UI:** el "nuevo plan" **no es realmente un dropdown libre**: es un valor
> calculado (`pagadas+1`). La pantalla debería **mostrarlo ya resuelto** con su tasa, no
> pedir que se elija (o, si se ofrece elección, solo `pagadas+1` pasa la validación).

### 2.2 La cuota sobreviviente
- Es la **primera cuota no `PAID`** (`installment_number = pagadas+1`).
- **Conserva su `due_date` original** (regla "la cuota final conserva su fecha del calendario original").
- Las cuotas posteriores (`pagadas+2 … última`) se **anulan**.

### 2.3 Requisitos de tasa
- Debe existir una tasa configurada para `(frequency, pagadas+1[, monto])`. Si no, el cambio
  es inválido (mensaje claro).

---

## 3. Alternativas de cálculo del nuevo saldo

Notación: `capital` = `getFinancedAmount(credit)`, `pagado` = Σ `amount_paid`, `r` = nueva tasa.

### Opción A — Recalcular todo el crédito con la nueva tasa y restar lo pagado **(CONFIRMADA por negocio)**

> Cerrado: negocio validó esta fórmula y aclaró que **la reducción de interés es intencional**
> (`cambio-de-plan.md` líneas 387–443). Las Opciones B y C quedan descartadas.
```
nuevo_total  = capital × (1 + r)          // getTotalWithInterest(capital, r)
nuevo_saldo  = nuevo_total − pagado
```
Ejemplo del doc: `100.000 × 1,10 − 40.000 = 70.000`. ✔ coincide exacto.

- **Ventajas:** es el modelo mental del dueño y el ejemplo literal; reutiliza el motor actual
  (`getTotalWithInterest`); simple y explicable al cliente.
- **Desventajas:** resta pagos hechos a la tasa **vieja** (20%) de un total a tasa **nueva**
  (10%); en la práctica **devuelve/condona parte del interés ya cobrado**. Es una decisión
  comercial generosa con el cliente — hay que **confirmarla con negocio**. Requiere guard
  `nuevo_saldo > 0`.

### Opción B — Recalcular solo el saldo pendiente
Tomar el saldo pendiente actual y aplicarle la nueva tasa. **Problema:** el saldo pendiente
actual ya tiene interés viejo incorporado (cuotas planas = capital+interés mezclados). Re-tasar
"lo pendiente" no tiene una definición financiera limpia en el modelo actual y **no** da el
número del ejemplo. Descartada por ambigua.

### Opción C — Separar capital de interés y re-tasar solo el capital remanente
Financieramente la más "pura": calcular capital remanente y aplicarle `r`. **Problema:** el
sistema usa **cuotas planas iguales**, no amortización; no guarda "capital remanente" por
cuota. Implementarla obliga a inventar un esquema de amortización que hoy no existe → mucho
más costo y cambia la semántica del producto. Descartada para v1.

**Recomendación: Opción A**, con guard de saldo positivo y confirmación explícita de negocio
sobre la condonación implícita de interés.

---

## 4. Impacto sobre las cuotas

### Alternativa 1 — Modificar la cuota viva sobreviviente y anular las futuras **(recomendada)**
- Cuota sobreviviente `S` (= `pagadas+1`): se setea para que su **saldo** sea `nuevo_saldo`,
  conservando su `due_date`:
  ```
  S.original_amount = nuevo_saldo + S.amount_paid   // si tenía pago parcial, se preserva
  S.penalty_amount  = 0
  S.amount_due      = S.original_amount             // remaining = amount_due − amount_paid = nuevo_saldo
  S.status          = recalculado por due_date (PENDING/OVERDUE)
  ```
- Cuotas `pagadas+2 … última`: se marcan como **anuladas** (status que las saque del saldo).
- Crédito: queda `ACTIVE` con una sola cuota viva; al pagarse, `_checkAndSettleCredit` lo
  liquida por el flujo normal.

**Por qué:** cumple al pie "no crear cuotas / no mover fechas / no nuevo calendario". La cuota
final ya existe con la fecha correcta (`installment_number = pagadas+1`).

### Alternativa 2 — Anular futuras y crear una "cuota especial de cancelación"
Contradice "no crear nuevas cuotas". Además habría que asignarle número y fecha. Descartada.

### Alternativa 3 — variantes
No aportan sobre la 1.

#### Estado de las cuotas anuladas — CERRADO
Negocio definió un **estado propio** y **prohibió reutilizar `REFINANCED`**
(`cambio-de-plan.md` líneas 457–463). Se adopta el nuevo status de cuota:

```
PLAN_CHANGE_CANCELLED   -- cuota futura anulada por un cambio de plan
```

Implica:
- Agregarlo al CHECK de `installments.status`.
- **Auditar TODA query que enumere estados** para que lo trate como "no vigente" (igual que
  `PAID`/`REFINANCED`): `getTotalPendingBalance`, `countPendingInstallments`,
  `getPendingInstallments`, inclusión de planillas (`collections`), cron de mora
  (no aplicar penalty), y reportes. Este es el principal foco de QA (ver §9).

#### Caso `nuevo_saldo ≤ 0` — CERRADO (cancelación automática)
Si `nuevo_total − total_pagado ≤ 0`, **no hay cuota sobreviviente**: se anulan **todas** las
cuotas pendientes (`PLAN_CHANGE_CANCELLED`) y el crédito pasa a `SETTLED` con
`settlement_type = 'PLAN_CHANGE'`, `settled_at = NOW()`. No se cobra nada.

#### Caso `nuevo_saldo > 0`
La cuota sobreviviente (`installment_number = pagadas+1`) queda con saldo = `nuevo_saldo`
(conservando su `amount_paid` parcial si lo tuviera y reseteando `penalty_amount = 0`), su
`due_date` original, y el crédito sigue `ACTIVE`. Al pagarse esa cuota por el flujo normal
(pre-carga → aprobación), `_checkAndSettleCredit` lo liquida. Para que el reporte distinga la
causa, el cambio queda registrado en `credit_plan_changes` (la liquidación final del pago
seguirá marcando `settlement_type='NORMAL'` salvo que se ajuste — ver §9.4).

---

## 5. Trazabilidad (auditable, sin tocar historia)

**Regla dura:** las cuotas pagadas y los `payments` históricos **no se tocan**.

Tabla nueva `credit_plan_changes` (espejo de `credit_refinancings`):

```
id                          UUID PK
credit_id                   UUID FK credits
-- snapshot ANTES
original_installments_count INT
original_rate               NUMERIC
original_total              NUMERIC   -- total a devolver original
paid_so_far                 NUMERIC   -- Σ amount_paid al momento del cambio
pending_before              NUMERIC   -- saldo previo
-- snapshot DESPUÉS
new_installments_count      INT       -- = pagadas + 1
new_rate                    NUMERIC
new_total                   NUMERIC   -- capital × (1 + new_rate)
new_balance                 NUMERIC   -- saldo recalculado (queda en la cuota viva)
surviving_installment_id    UUID FK installments
cancelled_installment_ids   JSONB     -- ids de cuotas anuladas
-- auditoría
reason                      TEXT
executed_by                 UUID FK users
executed_at                 TIMESTAMPTZ DEFAULT NOW()
```
Opcional: columnas snapshot en `credits` (`plan_changed_at`, `plan_changed_by`) como atajo de
lectura, igual que hizo refinanciación.

**Plan/tasa original en `credits`:** se mantienen **congelados** (como ya están). El "plan
vigente" tras el cambio se deriva de `credit_plan_changes` + el estado de las cuotas. (Si el
equipo quiere que la fila `credits` refleje el plan nuevo, agregar columnas `current_*`; lo
dejo como decisión, no es necesario para cobrar.)

---

## 6. Reutilización de código (evitar duplicar fórmulas)

| Necesidad | Reusar |
|---|---|
| Nueva tasa del plan | `interestRates.findActiveRate` (LOAN) / `productRates.findActiveRate` (SALE) |
| Total con nueva tasa | `creditCalculator.getTotalWithInterest` |
| Capital | `getFinancedAmount` (`credits.service.js:33`) |
| Saldo / pendientes | `getTotalPendingBalance`, `getPendingInstallments` |
| Locks + guards | patrón de `refinance()` (FOR UPDATE, ACTIVE, sin pre-cargas PENDING) |
| Auditoría | patrón `credit_refinancings` → `credit_plan_changes` |
| Simulación previa | patrón de `simulate()` (mismo cálculo, sin persistir) |
| Liquidación al pagar | `_checkAndSettleCredit` del módulo payments (sin cambios) |

No se duplica ninguna fórmula: el cálculo sale del mismo motor que la creación/simulación.

---

## 7. Cambios de backend

1. **Migración** `0NN_credit_plan_changes.sql`:
   - tabla `credit_plan_changes` (ver §5);
   - nuevo valor `PLAN_CHANGE_CANCELLED` en el CHECK de `installments.status`;
   - nuevo valor `PLAN_CHANGE` en el CHECK de `credits.settlement_type`;
   - (opcional) columnas snapshot en `credits` (`plan_changed_at`, `plan_changed_by`).
2. **`creditCalculator`**: sin cambios (se reutiliza).
3. **`credits.queries.js`**: `lockInstallments` (ya existe), helpers para
   `cancelInstallments(ids)`, `setSurvivingInstallment(...)`, `createPlanChangeRecord(...)`,
   y un `getPlanChangeContext(creditId)` (capital, pagadas, pagado, primera cuota viva).
4. **`credits.service.js`**:
   - `simulatePlanChange(creditId)` → calcula y devuelve `{ plan_actual, pagadas, saldo_actual,
     nuevo_plan, nueva_tasa, nuevo_saldo, cuota_final, fecha_final }`. No persiste. Valida que
     exista tasa para `pagadas+1` y `nuevo_saldo > 0`.
   - `changePlan(creditId, { reason }, adminId)` → transacción `FOR UPDATE`: lock crédito+cuotas,
     revalidar (ACTIVE, sin pre-cargas PENDING, tasa existente), recalcular `nuevo_saldo`, y:
     - si `nuevo_saldo > 0`: setear cuota sobreviviente, anular futuras (`PLAN_CHANGE_CANCELLED`),
       crédito sigue ACTIVE;
     - si `nuevo_saldo ≤ 0`: anular todas las pendientes y liquidar el crédito
       (`SETTLED`, `settlement_type='PLAN_CHANGE'`);
     - registrar `credit_plan_changes` en ambos casos.
5. **Endpoints** (`credits.routes.js`, solo ADMIN):
   - `GET /credits/:id/plan-change/simulate`
   - `POST /credits/:id/plan-change`  (body: `{ reason }`)
6. **Validators** (`utils/validators.js`): `credits.planChange` (reason mín. 5).
7. **Guards de negocio:** crédito `ACTIVE`; al menos una cuota pagada y al menos una viva;
   sin pre-cargas `PENDING` (igual que refinance/earlySettlement); tasa existente; saldo > 0.

> **Nota de caja:** el cambio de plan **no mueve caja** (solo reestructura deuda). El cobro de
> la cuota final sigue el flujo normal **pre-carga → aprobación del Admin** (ver
> `docs/claude-negocio.md`). Coherente con la regla "todo va a aprobación".

## 8. Cambios de frontend (`D:\gestion-creditos-f`)

Patrón a espejar: el diálogo de refinanciación ya existente.
- `features/seller/operations/credit-detail/refinance-dialog/` → crear hermano
  `plan-change-dialog/`.
- Disparador en `features/seller/operations/credit-detail/credit-detail.component` (botón
  "Cambio de plan", visible solo ADMIN y si el crédito es ACTIVE y elegible).
- Servicio: agregar `simulatePlanChange()` y `changePlan()` al service de créditos (mismo
  patrón que refinance).
- UI (según `cambio-de-plan.md`): mostrar plan actual, cuotas pagadas, saldo actual, nuevo plan
  (calculado = pagadas+1) y su tasa, nuevo saldo, cuota final y su fecha. **Simulación previa
  siempre antes de confirmar** (llamar a `/plan-change/simulate` al abrir, antes del POST).
- Reusar componentes de presentación de `simulator.component` / `credit-simulation.component`
  para el resumen.

## 9. Decisiones cerradas y pendientes técnicos

### 9.A Cerrado por negocio (ya no son riesgos)
- Condonación de interés: **intencional** (no es bug).
- `nuevo_saldo ≤ 0`: **cancela el crédito automáticamente** (§4).
- Estado de cuotas anuladas: **estado propio `PLAN_CHANGE_CANCELLED`**, no `REFINANCED` (§4).
- SALE: **fuera de V1**.
- Reversión: **no en V1**, el cambio es definitivo.

### 9.B Riesgos técnicos a controlar (de implementación, no de negocio)
1. **Propagación del nuevo status `PLAN_CHANGE_CANCELLED` (riesgo principal).** Hay que revisar
   **todas** las queries que listan estados de cuota para que lo excluyan del saldo, la planilla,
   el settlement y la mora. Un olvido = saldo/planilla inconsistentes. QA dedicado + test de
   integración que verifique saldo y cierre tras un cambio de plan.
2. **Concurrencia.** Ejecutar bajo transacción con `FOR UPDATE` sobre crédito + cuotas, y
   **rechazar si hay pre-cargas `PENDING`** (un cobro a medio aprobar invalidaría el cálculo) —
   mismo guard que `refinance`/`earlySettlement`.
3. **Cuota sobreviviente con pago parcial / mora previa.** Diseño: conservar `amount_paid`
   parcial, **resetear `penalty_amount = 0`**, y setear `amount_due` para que el saldo restante
   sea exactamente `nuevo_saldo`. Cubrir con test.
4. **`settlement_type` del pago final (menor).** En el caso `nuevo_saldo > 0`, cuando se cobra
   la cuota sobreviviente, `_checkAndSettleCredit` marca `NORMAL`. La causa "cambio de plan"
   queda igualmente trazada en `credit_plan_changes`; si se quiere que el crédito muestre
   `PLAN_CHANGE`, hay que ajustar el settle (mismo patrón pendiente que cancelación anticipada).
5. **Validez de tasa.** Si no existe tasa configurada para `(frequency, pagadas+1)`, el cambio
   es inválido → mensaje claro en la simulación, antes de habilitar el confirmar.

### 9.C Aprobación — CERRADO por negocio
El cambio de plan **NO requiere doble aprobación**: es una operación **exclusiva de Admin**,
en un paso. **No** genera movimientos de caja, **ni** de tesorería, **ni** arqueos, **ni**
estado PENDING. Flujo: **SIMULAR → CONFIRMAR (admin) → EJECUTAR → AUDITORÍA** (trazabilidad en
`credit_plan_changes`). (`cambio-de-plan.md` líneas 530–582.)

## 10. Plan de implementación por etapas

- **Etapa 0 — Definiciones de negocio:** ✅ CERRADA (Opción A, LOAN-only, saldo≤0 cancela,
  estado propio, sin reversión, auditoría). **Único punto a confirmar:** ¿el cambio requiere
  doble aprobación o alcanza confirmación del Admin? (§9.C — no bloquea el diseño).
- **Etapa 1 — Simulación (backend):** ✅ **IMPLEMENTADA** (rama `feat/cambio-de-plan`).
  `service.simulatePlanChange(creditId)` + `GET /credits/:id/plan-change/simulate` (ADMIN,
  solo lectura, no persiste). Devuelve `{ currentPlan, newPlan, totalPaid, newCreditTotal,
  newBalance, survivingInstallmentId, cancelledInstallments, creditWillBeSettled }`. Reutiliza
  `getFinancedAmount`, `getTotalWithInterest` e `irQueries.findActiveRate`. Tests:
  `credits.planchange.test.js` (8 casos: 6→3, SALE, no-ACTIVE, 404, sin tasa, fuera de orden,
  no más corto, saldo≤0).
- **Etapa 2 — Ejecución (backend):** migración `credit_plan_changes` (+status), `changePlan`
  transaccional, endpoint `POST`, validators. Tests unit + integración (cierre/saldo consistente,
  cuotas pagadas intactas, cuota viva con fecha original, futuras anuladas, auditoría escrita).
- **Etapa 3 — Frontend:** `plan-change-dialog` + botón en credit-detail + service, con
  simulación previa obligatoria.
- **Etapa 4 — Reportes/visualización:** mostrar historial de cambios de plan en el detalle;
  (opcional) columnas `current_*` y/o reversibilidad.

---

## Anexo — Cálculo de referencia (ejemplos del requerimiento)

Crédito LOAN: capital 100.000, 6 cuotas, 20% → total 120.000, cuota 20.000.
Pagadas 2 (40.000). Cambio a plan de 3 cuotas (tasa 10%):
```
pagadas      = 2  → nuevo_count = 3   (válido: deja 1 cuota viva, la #3)
nuevo_total  = 100.000 × 1,10 = 110.000
nuevo_saldo  = 110.000 − 40.000 = 70.000
cuota #3 (sobreviviente): amount_due tal que remaining = 70.000, conserva su due_date original
cuotas #4..#6: anuladas
```
