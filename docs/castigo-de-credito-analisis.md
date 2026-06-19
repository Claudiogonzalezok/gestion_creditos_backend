# Castigo de Crédito (Write Off) — Análisis técnico y diseño

> Estado: **ANÁLISIS / DISEÑO. No implementado.** Documento para validar con
> negocio antes de codear. Requerimiento: `castigo-de-credito.md`.

## 0. Resumen ejecutivo
**Castigo (write off)** = retirar un crédito de la operatoria de cobranza cuando el
negocio decide no seguir intentando cobrarlo. **Alcance V1: castigo COMPLETO del
crédito** (no condonación parcial, no perdón de cuotas, no cierres automáticos).

Recomendación: es **el mismo patrón que ya usa la refinanciación** (`markAsRefinanced`):
un estado terminal en el crédito + cerrar las cuotas abiertas con un estado propio +
tabla de auditoría. No se borra ni se toca nada histórico.

- **Estado de crédito nuevo:** `WRITTEN_OFF` (≠ SETTLED, que implica deuda cobrada).
- **Estado de cuota nuevo:** `WRITTEN_OFF` para las cuotas abiertas al castigar.
- **Auditoría:** tabla `credit_write_offs` (motivo, observaciones, usuario, fecha, saldo castigado).

---

## 1. Modelo actual y puntos de impacto (verificado en código)

### 1.1 Estados
- `credits.status`: `PENDING_APPROVAL, ACTIVE, SETTLED, REJECTED, EXPIRED, REFINANCED` (migración 009). → agregar `WRITTEN_OFF`.
- `installments.status`: `PENDING, PAID, PARTIAL, OVERDUE, REFINANCED, PLAN_CHANGE_CANCELLED`. → agregar `WRITTEN_OFF`.

### 1.2 Cómo se excluye hoy "lo no vigente" (dos mecanismos)
- **Por estado de crédito (`c.status='ACTIVE'`):** planilla (`collections.queries` inclusión, ~línea 223), reporte de cartera activa (`reports.queries` `active_pending_balance`), etc.
- **Por estado de cuota:** dos formas:
  - **Inclusión** `i.status IN ('PENDING','PARTIAL','OVERDUE')` → **excluye automáticamente** cualquier estado nuevo. Lo usan: planilla, `getPendingInstallments`, y **el cron de mora** (`overdueInstallments.job` línea 139).
  - **Exclusión** `i.status NOT IN ('PAID','REFINANCED','PLAN_CHANGE_CANCELLED')` → hay que **agregar explícitamente** el estado nuevo. Lo usan: `installmentSql.IS_OVERDUE_DERIVED`, `reports.queries` (×3), `payments.queries` (×4: saldo pendiente, conteo de pendientes, distribución, shift).

> **Hallazgo clave:** el **cron de mora NO filtra por estado del crédito**, solo por
> estado de cuota. Por eso **no alcanza con poner el crédito en WRITTEN_OFF**: si las
> cuotas siguen `OVERDUE/PENDING`, el cron les seguiría aplicando mora. **Hay que
> cerrar las cuotas abiertas** (igual que hace refinanciación). Esto responde el
> requisito "qué pasa con cálculos de mora".

---

## 2. Diseño propuesto

### 2.1 Qué hace el castigo (atómico, en transacción)
Sobre un crédito **ACTIVE** (único estado elegible):
1. Lock del crédito + cuotas (`FOR UPDATE`).
2. Validar: status `ACTIVE`; opcionalmente, **rechazar si hay pre-cargas PENDING** (resolverlas antes — como refinanciación/cambio de plan).
3. Tomar snapshot del **saldo pendiente** = Σ(`amount_due − amount_paid`) de cuotas abiertas (para reportes de "cartera castigada").
4. Marcar **cuotas abiertas** (`PENDING/PARTIAL/OVERDUE`) → `WRITTEN_OFF`. (Las `PAID` quedan intactas.)
5. Marcar **crédito** → `WRITTEN_OFF` + snapshot (`written_off_at/by/reason`).
6. Insertar registro en **`credit_write_offs`** (auditoría).

### 2.2 Qué pasa con cada cosa (responde el requisito 4)
| Concepto | Resultado |
|---|---|
| **Cuotas pagadas (PAID)** | **Intactas.** Nunca se tocan. |
| **Pagos históricos (payments)** | **Intactos.** No se borran ni modifican. |
| **Cuotas pendientes/vencidas** | Pasan a `WRITTEN_OFF` (salen de saldo, planilla, mora). |
| **Saldo pendiente operativo** | Queda en **0** (las cuotas castigadas se excluyen). El monto castigado se preserva en `credit_write_offs.written_off_balance`. |
| **Mora** | **Se detiene** (las cuotas ya no entran al cron). La mora ya aplicada queda registrada en el histórico, no se borra. |
| **Comisión (SALE)** | Decisión de negocio (ver §6). Por defecto **no se toca** en V1. |

### 2.3 Exclusión de la operatoria (responde el requisito 5)
- **Planillas / "cobrar hoy" / gestión:** doble cobertura → el crédito deja de ser `ACTIVE` (lo excluye el filtro `c.status='ACTIVE'`) **y** sus cuotas dejan de estar en `('PENDING','PARTIAL','OVERDUE')`. Cero riesgo de que aparezca.
- **Cron de mora:** las cuotas `WRITTEN_OFF` no entran a la inclusión → no se les aplica mora.
- **Saldos/reportes operativos:** agregar `WRITTEN_OFF` a los `NOT IN ('PAID','REFINANCED','PLAN_CHANGE_CANCELLED')` (installmentSql, reports ×3, payments ×4) para que las cuotas castigadas no cuenten como saldo.

---

## 3. Auditoría (responde el requisito 3) — tabla `credit_write_offs`
Espejo de `credit_refinancings` / `credit_plan_changes`:
```
id                    UUID PK
credit_id             UUID FK credits
written_off_balance   NUMERIC(12,2)   -- saldo pendiente al momento del castigo (lo que se deja de cobrar)
reason                TEXT NOT NULL    -- motivo (obligatorio)
observations          TEXT NULL        -- observaciones
executed_by           UUID FK users
executed_at           TIMESTAMPTZ DEFAULT NOW()
```
Más, en `credits` (snapshot rápido, como refinanciación): `written_off_at`, `written_off_by`, `written_off_reason`.

Toda la info histórica se mantiene; el castigo es **aditivo** (nuevos estados + registro), nunca destructivo.

---

## 4. Dashboards y reportes (responde el requisito 1)
- **Reporte de cartera** (`reports.queries` `by_status_type`): agrupa por status → `WRITTEN_OFF` aparece como **su propia categoría** automáticamente. `active_pending_balance` filtra `c.status='ACTIVE'` → ya excluye castigados. ✅
- **Reporte de mora / cartera activa:** las cuotas `WRITTEN_OFF` salen vía los `NOT IN` actualizados.
- **A auditar (no necesariamente cambiar):** dashboard de pendientes, delincuencia, y cualquier KPI que cuente créditos/cuotas — confirmar que filtren por `ACTIVE` o por la inclusión de estados, para que los castigados no inflen métricas. (Se revisa en implementación.)
- **Nuevo (opcional):** una métrica/reporte de **"cartera castigada"** (suma de `written_off_balance`), valiosa para el negocio.

---

## 5. Reutilización de código
Se apoya casi entero en el patrón existente de refinanciación:
- `lockCredit`, `lockInstallments`, `hasPendingPayments` (ya existen).
- `markAsRefinanced` es el espejo exacto de lo que hará `writeOffCredit` (credit + cuotas).
- Patrón de tabla de auditoría (`credit_refinancings` / `credit_plan_changes`).
- El predicado de "cuota no vigente" ya está centralizado en parte (`installmentSql`); el resto son los `NOT IN` a extender.

---

## 6. Riesgos y decisiones de negocio (a validar)
1. **¿Reversible?** Si el cliente reaparece y paga (recovery), ¿se puede "des-castigar"? Recomiendo **no en V1** (recovery = 2da etapa); diseñar como **definitivo** pero dejando la puerta abierta (la auditoría permite reconstruir).
2. **¿Se bloquean pagos sobre un crédito WRITTEN_OFF?** Recomiendo **sí** (está retirado de cobranza). Recovery sería la excepción de la 2da etapa.
3. **Comisión del vendedor (SALE):** ¿castigar revierte la comisión ya devengada? Hoy la mora SALE genera comisión negativa (REVERSED). El castigo podría hacer algo análogo. **Decisión de negocio**; por defecto no se toca en V1.
4. **Elegibilidad:** solo `ACTIVE`. ¿Se exige un mínimo (ej. X días de mora) o el admin puede castigar cualquier ACTIVE? Recomiendo dejar criterio al admin + motivo obligatorio.
5. **Estado de cuota nuevo `WRITTEN_OFF`:** igual que con `PLAN_CHANGE_CANCELLED`, hay que propagarlo a todos los enumeradores de estado (los `NOT IN`). Es el principal foco de QA.
6. **¿Quién puede castigar?** Solo ADMIN (operación sensible, irreversible).

---

## 7. Cambios backend (resumen)
1. Migración: `credits.status += 'WRITTEN_OFF'`; `installments.status += 'WRITTEN_OFF'`; columnas snapshot en `credits`; tabla `credit_write_offs`.
2. Propagar `WRITTEN_OFF` a los `NOT IN ('PAID','REFINANCED','PLAN_CHANGE_CANCELLED')` (installmentSql, reports ×3, payments ×4).
3. Service `writeOffCredit(creditId, { reason, observations }, adminId)` transaccional (lock, validar, snapshot saldo, marcar cuotas+crédito, auditar). Espeja `refinance`/`changePlan`.
4. Bloquear pagos/operaciones sobre créditos `WRITTEN_OFF` (los flujos que validan `ACTIVE` ya lo hacen; revisar payments).
5. Endpoint `POST /credits/:id/write-off` (ADMIN) + validador (reason obligatorio).
6. Tests unit + integración (saldo→0, cuotas abiertas WRITTEN_OFF, PAID intactas, excluido de planilla/mora, auditoría escrita).

## 8. Cambios frontend
- Botón "Castigar crédito" en el detalle (ADMIN, crédito ACTIVE), con confirmación + motivo/observaciones (diálogo, espejo de los existentes).
- Mostrar el estado `WRITTEN_OFF` (tag + label "Castigado") en detalle y listados.
- (Opcional) vista/badge de cartera castigada.

## 9. Plan por etapas
- **Etapa 0 — Negocio:** confirmar §6 (reversibilidad, bloqueo de pagos, comisión, elegibilidad).
- **Etapa 1 — Backend:** migración + service + endpoint + propagación de estado + tests.
- **Etapa 2 — Frontend:** botón + diálogo + visualización del estado.
- **Etapa 3 (futura, fuera de alcance):** condonación parcial, perdón de cuotas, recovery de castigados, cierres automáticos.

---

> No implementar hasta validar §6 con negocio.
