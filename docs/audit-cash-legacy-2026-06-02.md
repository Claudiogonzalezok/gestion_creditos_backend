# Auditoría legacy — Módulo Caja (post bloque D)

**Fecha:** 2026-06-02
**Rama base:** `main` (commit `e4d5cd4`)
**Alcance:** estado del módulo legacy `cash_registers` + `cash_movements` tras los fixes de Camino 2 (deprecación blanda) aplicados en IMP-1 + IMP-8.
**Suite:** 226/226 integration + 58/58 unit verde.

---

## 1. Lugares donde aún se ESCRIBE en tablas legacy

| Tabla | Archivo / función | Por qué se conserva |
|---|---|---|
| `cash_movements` | `payments.service._registerCashMovement` (`approve`, `adminDirect`, `reverse`) → `cashMovementsQueries.create` | Cache derivado que alimenta el dashboard legacy (`cashRegister.queries.getDashboard`). Sin él, el dashboard antiguo del frontend rompe. |
| `cash_registers` | `cashRegister.service.close` → `queries.create` | Endpoint público `POST /api/cash-register/close` sigue expuesto para compat del UI antiguo. Ya NO ejecuta `linkLiquidations` (CRIT-2). |

**Total: 2 escrituras vivas**, ambas planificadas en `feat/cash-system-cleanup`.

---

## 2. Lugares donde aún se LEE de tablas legacy

| Tabla | Archivo / función | Naturaleza |
|---|---|---|
| `cash_movements` | `payments.service.reverse` línea 587 → `findPaymentMovement(client, id)` | Lectura del `register_date` para usar como fecha contable de la reversión. Funcional pero acoplado al legacy. |
| `cash_registers` | `cashRegister.queries.getDashboard` / `getDailyTotals` / `getPreClose` | Lectura del dashboard antiguo. Sigue sirviendo al endpoint legacy. |
| `cash_movements` | `cashRegister.queries.getDashboard` (vía JOIN al sumar payments) | El dashboard antiguo consulta `cash_movements` indirectamente. |
| `cash_registers` | Tests integration `cash-register-no-double-commissions.test.js` | Coverage del fix CRIT-1 sobre el módulo legacy. Válido mientras exista el dashboard. |

**Total: 4 lecturas vivas.** Las del dashboard caen junto con el módulo cuando se haga cleanup. La de `reverse` puede migrarse a `payments.approved_at::date` antes del cleanup.

---

## 3. Riesgos pendientes

| ID | Riesgo | Severidad | Mitigación actual |
|---|---|---|---|
| R-1 | `cash_movements` y `cash_sessions.closure_snapshot` se desincronizan si una tx escribe en una pero falla en la otra | BAJA | Ambas escrituras están dentro del mismo `withTransaction` en `payments.approve/adminDirect/reverse`. Riesgo solo si se introduce código que escriba parcial. |
| R-2 | `cashRegister.service.close` puede ejecutarse aunque ya exista `business_days.CLOSED` para la fecha → estado contradictorio | BAJA | El admin que cierre legacy entiende que es operación informal. No hay enforcement cruzado. |
| R-3 | Dashboard antiguo y endpoints Caja General pueden mostrar datos divergentes si el operador hace cuentas a mano | MEDIA | Tras CRIT-1 ya no doble-cuentan commissions. Otros conceptos (drops, expenses) están alineados. |
| R-4 | Unit test `payments.service.test.js` mockea `cashRegisterQueries.findByDate` que ya no se llama | BAJA | El test sigue verde; el mock se ignora silenciosamente. Limpieza recomendada. |
| R-5 | El campo `commission_liquidations.cash_register_id` queda NULL en nuevas liquidaciones pero la columna sigue existiendo | BAJA | Documental — la columna desaparece en cleanup. |

---

## 4. Deuda técnica identificada

| ID | Item | Tipo |
|---|---|---|
| D-1 | Tabla `cash_movements` íntegra | DB |
| D-2 | Tabla `cash_registers` íntegra | DB |
| D-3 | Módulo `src/modules/cashRegister/` (queries + service + controller + routes) | Código |
| D-4 | Módulo `src/modules/payments/cash_movements.queries.js` | Código |
| D-5 | Columnas en `commission_liquidations`: `cash_register_id`, `cash_session_id` (esta última post-Fase 3 también queda NULL en nuevas filas) | DB |
| D-6 | Keys deprecadas en `closure_snapshot v1`: `outflows.commissions.cash/transfer` (siempre 0) | Schema JSON |
| D-7 | Columna `cash_session_drops.destination` (texto libre, ya nullable) | DB |
| D-8 | Helper `cashRegister.queries.findUnclosedJornadaDate` (sin callers vivos en negocio post-IMP-1) | Código |
| D-9 | Helper `cashRegister.queries.linkLiquidations` (no-op tras CRIT-2) | Código |
| D-10 | Mocks obsoletos en `payments.service.test.js` (`cashRegisterQueries.findByDate`) | Tests |

---

## 5. Recomendación para `feat/cash-system-cleanup`

Orden propuesto, en commits independientes (cada uno reversible):

1. **Migrar lectura de `findPaymentMovement` en `payments.reverse`** — reemplazar por `payment.approved_at::date`. Único consumer vivo de `cash_movements` para lectura de negocio. Sin esto el cleanup queda bloqueado.
2. **Eliminar escritura a `cash_movements`** — sacar `_registerCashMovement` del flujo de payments. Confirmar que el dashboard ya no lo consume.
3. **Snapshot v2 sin commissions** — versionar `closure_snapshot` para retirar `outflows.commissions` y eliminar la rama de compat en `cashSessions.service.snapshot`.
4. **Eliminar el módulo `cashRegister`** — controller, routes, service, queries. Eliminar la ruta `/api/cash-register/*` (coordinar con frontend para que el dashboard nuevo lo reemplace).
5. **Eliminar el módulo `cash_movements.queries.js`** — junto con el unit test mock obsoleto.
6. **Drop migraciones**:
   - Drop tabla `cash_movements`.
   - Drop tabla `cash_registers`.
   - Drop columnas `commission_liquidations.cash_register_id`, `commission_liquidations.cash_session_id`.
   - Drop columna `cash_session_drops.destination`.
7. **Limpieza de tests** — borrar `cash-register-no-double-commissions.test.js` (ya no hay legacy que validar) y los mocks obsoletos en `payments.service.test.js`.

**Pre-requisito antes de arrancar el cleanup:** confirmar que el frontend dejó de consumir `GET /api/cash-register/dashboard`, `GET /api/cash-register/pre-close`, `POST /api/cash-register/close`. Sin esa confirmación, el paso 4 rompe la UI.

---

## 6. Contexto histórico

Esta auditoría cerró:

- **3 hallazgos críticos** (commits `282c63b`, `7218a53`, `9741b77`):
  - CRIT-1: doble-cómputo de `commission_liquidations` en dashboard legacy.
  - CRIT-2: `linkLiquidations` reenganchaba liquidaciones Fase 3 al cierre legacy.
  - CRIT-3: CHECK constraint `current_balance >= 0` en `cash_accounts`.

- **8 hallazgos importantes** (commits `5627dee`, `1274c74`, `bf04ec0`, `ac7c892`, `a5e7598`, `96f2c0d`, `c7aae2a`, `83e68ee`, `137d6d6`, `e4d5cd4`):
  - IMP-2: re-validación TOCTOU bajo lock dentro de la tx (5 callers).
  - IMP-3: bloquear cuentas inactivas en flujos automáticos.
  - IMP-4: eliminar fallback frágil de `createDrop`.
  - IMP-5: endpoint `force-close` para `business_days` trabados.
  - IMP-6: bloquear `SALARY_PAYMENT` desde endpoint público.
  - IMP-7: `expenses` chequea `cash_sessions.status` además del legacy.
  - IMP-1: autoridad operativa migra a `business_days` (Camino 2).
  - IMP-8: deprecación blanda documentada del legacy.

Tests nuevos agregados durante la auditoría: 26 (bloques Q, R, S, T, U + extensiones a O y M).
