# Análisis e implementación — Frecuencia de pago DAILY (Diaria)

> Basado en evidencia real del código (backend `gestion_creditos_backend` +
> frontend `gestion-creditos-f`), 2026-07-09. Objetivo: agregar `DAILY` como una
> frecuencia más (cuota cada 1 día), con mínimo impacto y máxima reutilización,
> sin romper WEEKLY/BIWEEKLY/MONTHLY.

## Decisiones confirmadas (negocio, 2026-07-09)

1. **Implementar DAILY ahora**, como una frecuencia más (no flujo ni tipo de crédito
   separado). Se integra al mismo modelo de cuotas.
2. **Días corridos, sin corrimiento hábil.** DAILY **NO** aplica
   `applyBusinessDayRuleToDueDates`: las cuotas vencen todos los días (incluidos
   domingos/feriados). Esto elimina de raíz el riesgo de solapamiento de cuotas.
3. **Se mantiene** el flujo actual de aprobación y cobranzas.
4. **Ramas explícitas DAILY** en JS (`addFrequencyPeriods`) y SQL
   (`shiftInstallmentDates`), y **se elimina el `else` mensual silencioso**: cada
   frecuencia conocida es una rama explícita y el `default`/`else` **lanza error** ante
   una frecuencia no soportada (para que ninguna frecuencia futura vuelva a caer en
   mensual sin querer).
5. **Centralizar** en el front el tipo y las opciones de frecuencia (eliminar la
   duplicación actual aprovechando el cambio).
6. Secuencia: **commitear este doc primero**, luego implementar por etapas
   (BD → Backend → Frontend → Tests).

---

## 0. Hallazgo estructural (lo que hace viable el "mínimo impacto")

**La frecuencia solo importa en DOS lugares del cálculo de fechas; el resto del
sistema es frecuencia-agnóstico** (trabaja por `due_date`):

1. `creditCalculator.addFrequencyPeriods` (JS) — genera el cronograma (alta,
   simulación, refinanciación, cambio de plan; todos pasan por
   `getDueDatesFromFirstPayment`).
2. `payments.queries.shiftInstallmentDates` (SQL) — reprograma las cuotas
   restantes cuando se adelantan cuotas.

Verificado por búsqueda: **planillas/cobranzas (`collections`), `installments`,
y el cron de mora (`overdueInstallments`) NO referencian `payment_frequency`** →
funcionan con DAILY sin tocar nada. La mora deriva de `due_date + grace_days`
(`IS_OVERDUE_DERIVED`), por cuota, independientemente de la frecuencia.

⇒ El grueso del trabajo es: **2 funciones de fecha + CHECK de BD + validators +
tipos/selectores del front + tasas configuradas para DAILY.**

---

## 1. Mapa completo de impacto

### 1.1 Base de datos

| Archivo | Objeto | Cambio |
|---|---|---|
| `001_create_tables.sql:162` | CHECK `interest_rates_payment_frequency_check` | Ampliar a incluir `'DAILY'` |
| `001_create_tables.sql:185` | CHECK `product_rates_payment_frequency_check` | Ampliar |
| `001_create_tables.sql:226` | CHECK `credits_payment_frequency_check` | Ampliar |
| `001_create_tables.sql:273` | CHECK `installments_payment_frequency_check` | Ampliar |
| `002_sale_product_rates_down_payments.sql:13` | CHECK de `product_rates` (re-creación) | Ampliar |

→ **Nueva migración** que hace `DROP CONSTRAINT` + `ADD CONSTRAINT ... CHECK (payment_frequency IN ('WEEKLY','BIWEEKLY','MONTHLY','DAILY'))` sobre las 4 tablas (mismo patrón que la migración 041 con `attempt_type`). Sin borrar datos, sin tocar columnas.

### 1.2 Backend — lógica (cambios de código)

| Archivo:línea | Función | Cambio |
|---|---|---|
| `utils/creditCalculator.js:54-65` | `addFrequencyPeriods` | **Agregar rama `DAILY`** → `due.setDate(base.getDate() + 1 * periods)`. Convertir el `if/else` en ramas explícitas por frecuencia y hacer que el caso desconocido **lance error** (no caer en mensual). |
| `payments.queries.js:365-368` | `shiftInstallmentDates` | Agregar `DAILY → interval '1 day'`. Dejar el CASE con las 4 frecuencias explícitas; el `ELSE` mensual se reemplaza por un error/guard (validación previa de frecuencia) para no reprogramar en mensual por defecto. |
| `utils/validators.js:350, 608-610, 723-725, 881-883, 1123-1125, 1220-1221` | validators de crédito/simulación/refinanciación | Agregar `'DAILY'` a cada `isIn([...])` |

**⚠️ Riesgo #1 (crítico):** tanto `addFrequencyPeriods` como `shiftInstallmentDates`
tienen un `else` que hoy asume MONTHLY. Si se agrega `DAILY` sin una rama explícita
en **ambos**, las cuotas diarias caerían en "mensual" → cronograma incorrecto. Son
los dos puntos obligatorios.

### 1.3 Backend — tasas (dato, no código)

Un crédito DAILY necesita una tasa configurada:
- **LOAN** → fila en `interest_rates` con `payment_frequency='DAILY'`
  (`credits.service.js` la busca por frecuencia+cuotas+monto; si no existe → 422).
- **SALE** → fila en `product_rates` con `payment_frequency='DAILY'`
  (`credits.service.js:451`: "No existe tasa configurada... 422").

→ Habilitado por el cambio de CHECK (1.1) + el selector del front (1.4). No requiere
seed obligatorio: el Admin las carga desde la UI de Configuración. **Debe documentarse**
que sin tasa DAILY, la aprobación falla con 422 (comportamiento esperado, igual que hoy
para cualquier combinación sin tasa).

### 1.4 Frontend

| Archivo | Qué es | Cambio |
|---|---|---|
| `admin/config/models/interfaces/interest-rate.model.ts:1` · `product.ts:17` · `seller/models/credit.model.ts:12` | **Tipo `PaymentFrequency`** (duplicado en 3 archivos) | Agregar `'DAILY'` en los 3 |
| `operation-form.service.ts` (`getFirstPaymentDateFromApprovalRule`) | Cálculo local de la 1ª cuota (+7/+14/+1 mes) | Agregar `DAILY → +1 día` (espejo del backend) |
| `step-conditions.component.ts:65` · `credit-create.component.ts:80` · `refinance-dialog.component.ts:53` · `simulator.component.ts` · `operation-form.service.ts` | Listas de opciones de frecuencia (**duplicadas**) | Agregar `{ label: 'Diaria', value: 'DAILY' }` |
| `admin/config/rates/interest-rates-config.component.ts:65` · `product-rates-config.component.ts:65` | Selector de frecuencia en **config de tasas** | Agregar 'Diaria' (para que el Admin cargue tasas DAILY) |
| `credit-detail.component.ts` (`frequencyLabel`/`frequencyUnitLabel`) · portal · listados | Label maps (Semanal/Quincenal/Mensual + "/mes,/semana") | Agregar 'Diaria' / '/día' |
| union types inline `'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'` en `step-conditions.component.ts:63,74,304,312,323`, `operation-form.service.ts:361` | Firmas de métodos | Agregar `'DAILY'` |
| `shared/utils/financial-calculator.util.ts` | Cálculo de montos (referencia frecuencias) | **Revisar** (no calcula fechas; verificar que no haya divisor por frecuencia hardcodeado) |

**Oportunidad de reutilización (recomendada):** hoy el tipo `PaymentFrequency` está
en 3 archivos y las listas de opciones/labels duplicadas en ~6 componentes. Antes de
esparcir `'DAILY'`, conviene **centralizar** en un único módulo compartido
(`FREQUENCY_OPTIONS`, `FREQUENCY_LABELS`, `type PaymentFrequency`) e importarlo. Así
DAILY (y cualquier frecuencia futura) es un cambio de **una línea**, no de ~10 lugares.
Es un refactor chico y alineado con "máxima reutilización".

---

## 2. Comportamiento esperado de DAILY (confirmado contra el diseño actual)

- **Vencimientos:** 1ª cuota `first_payment_date`; cada siguiente `+1 día`
  (`addFrequencyPeriods` con periods=0,1,2,... y `setDate(+1*periods)`). Ej: 10/08 →
  10, 11, 12, 13, 14/08 para 5 cuotas. ✅ Coincide con lo pedido.
- **Regla de día hábil:** **CONFIRMADO — DAILY NO aplica corrimiento hábil** (días
  corridos). No pasa por `applyBusinessDayRuleToDueDates`. Vence todos los días,
  incluidos domingos/feriados. → sin solapamiento de cuotas.
- **Cuotas adelantadas:** al adelantar, `shiftInstallmentDates` corre las restantes con
  `interval '1 day'` → misma lógica de corrimiento que hoy. ✅
- **Mora:** `due_date + grace_days` por cuota, igual que las demás. ✅ (ver nota en Riesgos
  sobre grace vs. diario).

---

## 3. Riesgos detectados

| Riesgo | ¿Aplica? | Mitigación |
|---|---|---|
| **Saltos de vencimiento** (DAILY cae en mensual) | **Sí, si no se implementa bien** | Rama `DAILY` explícita en `addFrequencyPeriods` **y** `shiftInstallmentDates` (ambos tienen `else` = mensual). Test obligatorio. |
| **Duplicación de fechas** | No (mitigado por decisión) | Cada cuota tiene `installment_number` único y `+1 día` distinto. Como DAILY **no** aplica regla de hábiles (días corridos), no hay empuje domingo→lunes que solape dos cuotas. |
| **Mora incorrecta** | Bajo | Frecuencia-agnóstica. Con DAILY, varias cuotas pueden estar impagas en simultáneo; cada una acumula mora independiente. Nota: con `grace_days=3`, una cuota diaria no entra en mora hasta 3 días después — coherente con el modelo, pero el negocio debería saber que "diario" no significa "mora al día siguiente" salvo que se baje `penalty_grace_days`. |
| **Planillas duplicadas** | No | La planilla deduplica por `installment_id`. Un crédito diario aporta **una** cuota por día a la planilla de ese día (esperado, no duplicado). |
| **Performance / volumen** | Moderado | Un crédito diario genera hasta **100 cuotas** (tope `validators.js:170`). Más filas en `installments`, más entradas en planillas/reportes. Las queries escalan (índices por `due_date`/`credit_id`), pero conviene revisar límites de UI (paginado del cronograma) y quizás un tope menor para DAILY. |
| **Regla de día hábil vs. diario** | Resuelto | **Decisión: días corridos.** DAILY no aplica `applyBusinessDayRuleToDueDates`. Implementación: excluir DAILY de esa función (guard por frecuencia). |

---

## 4. Plan de implementación por etapas

**Etapa 1 — Base de datos**
- Nueva migración: ampliar el CHECK de `payment_frequency` en `interest_rates`,
  `product_rates`, `credits`, `installments` para incluir `'DAILY'` (drop+add del
  constraint por nombre). Sin backfill, sin pérdida de datos.

**Etapa 2 — Backend**
- `addFrequencyPeriods`: rama `DAILY` (+1 día × periods).
- `shiftInstallmentDates`: `DAILY → '1 day'`.
- `validators.js`: `'DAILY'` en los ~6 `isIn`.
- Excluir DAILY de `applyBusinessDayRuleToDueDates` (días corridos, decisión confirmada).
- Eliminar los `else`/`ELSE` mensuales silenciosos: ramas explícitas + error en caso desconocido.
- (No tocar collections/mora/saldos — verificado frecuencia-agnósticos.)

**Etapa 3 — Frontend**
- (Recomendado) centralizar `PaymentFrequency` + `FREQUENCY_OPTIONS`/`FREQUENCY_LABELS`.
- Agregar `'DAILY'` / 'Diaria' / '/día' en tipo, selectores (incluye config de tasas),
  labels y `getFirstPaymentDateFromApprovalRule` (+1 día).
- Revisar `financial-calculator.util.ts`.

**Etapa 4 — Tests**
- Unit backend: `addFrequencyPeriods('DAILY')` genera fechas consecutivas;
  `shiftInstallmentDates` con DAILY corre `+1 día`.
- Integración: alta de crédito diario (fechas), adelanto de cuotas (corrimiento),
  refinanciación diaria, cambio de plan diario, aplicación de mora sobre diario,
  generación de planilla con crédito diario.
- Frontend: `getFirstPaymentDateFromApprovalRule('DAILY')` → +1 día; selectores muestran 'Diaria'.

---

## 5. Casos de prueba obligatorios (del requerimiento)

1. **Crédito diario de 7 cuotas** → 7 vencimientos consecutivos día a día; montos/tasa
   desde la tasa DAILY configurada.
2. **Venta diaria con cuotas adelantadas** → al adelantar, las restantes corren `+1 día`
   (`shiftInstallmentDates`), sin huecos ni solapamientos (salvo regla de hábiles).
3. **Refinanciación diaria** → el nuevo cronograma usa `addFrequencyPeriods('DAILY')`.
4. **Cambio de plan diario** → idem, vía `getDueDatesFromFirstPayment`.
5. **Aplicación de mora** → una cuota diaria vencida + grace entra en mora; varias en
   simultáneo acumulan independientemente.
6. **Generación de planilla** → un crédito diario aparece cada día en "Trabajo Diario"
   por la cuota que vence ese día; sin duplicados.

---

## 6. Resumen ejecutivo

- **Núcleo del cambio:** 2 funciones de fecha (`addFrequencyPeriods` JS +
  `shiftInstallmentDates` SQL), 1 migración de CHECK (4 tablas), ~6 validators.
- **Frecuencia-agnóstico (sin cambios):** planillas, cobranzas, mora, saldos, reportes
  que trabajan por `due_date`.
- **Frontend:** tipo + selectores + labels + cálculo de 1ª cuota; hoy están duplicados
  → conviene centralizar (refactor chico) para cumplir "máxima reutilización".
- **Dato operativo:** hay que **configurar tasas DAILY** (interest_rates/product_rates)
  o la aprobación falla con 422 (comportamiento esperado).
- **Decisión confirmada:** DAILY vence **días corridos** (sin regla de día hábil) → sin
  solapamiento de cuotas.
- **Riesgo #1 a cubrir sí o sí:** rama `DAILY` explícita en los dos `else` que hoy
  asumen mensual, y **eliminar el fallback mensual** (error ante frecuencia desconocida).
