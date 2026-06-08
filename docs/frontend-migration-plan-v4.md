# Plan de migración Frontend — Modelo de Caja V4

**Fecha:** 2026-06-03.
**Repo frontend:** `D:\gestion-creditos-f` (Angular 18 + PrimeNG + Tailwind).
**Reemplaza:** `docs/frontend-migration-plan-2026-06-02.md` (versión pre-V4, con "Mi caja" para cobradores).
**Backend de referencia:** `docs/cash-model-v4.md` (fuente de verdad arquitectónica).

---

## Cambios respecto al plan original

| Fase original | V4 |
|---|---|
| F1 — "Mi caja" para cobradores | **Eliminada.** Cobradores no operan caja (V4 directiva 1.3). |
| F1 (V4) — "Caja del turno" para ADMIN | Pantalla única: abrir/cerrar/arquear la caja operativa activa de la jornada. |
| F2 — Tesorería (Caja General) | Sin cambio. |
| F3 — Gestión de jornadas | Sin cambio. Incluye `force-close` (IMP-5). |
| F4 — Rediseño dashboard administrativo | Adaptado: el card pasa a "caja activa del día" (única, de la jornada). |
| F5 — Limpieza de chequeos legacy | Más simple en V4 — todos los chequeos pasan a "hay caja activa" (no "mi caja"). |
| F6 — Apagar legacy + señal verde para cleanup | Sin cambio. |
| F7 (V3) — "Rendir cobranzas" | **Eliminada.** V4 no tiene rendiciones (aprobación == recepción). |

---

## Mapeo conceptual (V4)

| Concepto operativo | Endpoint backend | Cambio para el UX |
|---|---|---|
| Dashboard del día | `GET /api/business-days?status=OPEN` + `GET /api/cash-sessions/active` + `GET /api/cash-accounts/:id/balance` | Lista de cajas del día + caja activa actual + saldo de tesorería. |
| Snapshot de la caja activa | `GET /api/cash-sessions/:id/snapshot` (X report) | Una caja a la vez. |
| Cierre de caja del turno | `POST /api/cash-sessions/:id/close` con `declared` por método | Cajero declara CASH/TRANSFER al cierre del turno. |
| Cierre de jornada (formal) | `POST /api/business-days/:id/close` | Supervisor cierra al final del día. |
| Forzar cierre con cajas PENDING | `POST /api/business-days/:id/force-close` con `reason` | Botón explícito en admin. |
| Apertura de caja | `POST /api/cash-sessions` con `opening_amount` | Solo ADMIN. Si la jornada está en `READY_TO_CLOSE`, vuelve a `OPEN` automáticamente. |
| Cobrador registra pre-carga | `POST /api/payments` (rol COLLECTOR) | **Sin requerir caja abierta.** El cobrador puede pre-cargar en cualquier momento. |
| Admin aprueba cobranza | `POST /api/payments/:id/approve` | Falla `409 NO_ACTIVE_SESSION` si no hay caja operativa abierta. |
| Liquidación de comisiones | `POST /api/commissions/liquidate` | Imputa a Caja General; no exige caja del admin. |
| Pagos corporativos | `POST /api/cash-accounts/:id/movements` (SUPPLIER_PAYMENT / EXPENSE / ADJUSTMENT) | Pantalla nueva (Tesorería). |
| Saldo Caja General | `GET /api/cash-accounts/:id/balance` + `/audit-balance` | Visible en dashboard admin. |

---

## Inventario actualizado de impacto (frontend)

Basado en `D:/gestion-creditos-f/docs/frontend-cash-audit.md` secciones 1-5.

### Pantallas que sobreviven sin cambios
- **Cobradores:** `/collector/route`, `/collector/payments`, `/collector/commissions`. Su pantalla "Mi caja" **no se crea** (V4).
- **Pre-carga de cobros:** componente que llama `payments.create` ya no necesita el check legacy de caja del cobrador. Solo eliminar el chequeo previo si existe.

### Pantallas / consumers a modificar
- **`dashboard.component`** (admin): reemplazar `cashRegisterSvc.getDashboard().is_closed` por una composición de `cash-sessions/active` + `business-days?status=OPEN`. El card "estado caja" pasa a "caja activa de la jornada".
- **`approvals.component`**, **`payments/payment-detail-dialog`**, **`payments/direct-payment-dialog`**, **`expenses/expense-side-panel`**, **`delinquency/*`**, **`seller/operations/credit-detail/*`** (≈ 13 consumers de `getDashboard()`): eliminar el chequeo legacy. El backend ya rechaza con `409 NO_ACTIVE_SESSION` y mensaje claro — basta con propagar el error.
- **`commissions.facade`**: eliminar el check `is_closed` (backend ya no exige caja del admin para liquidar — Fase 3.4).
- **`cash-register.component`** + sub-componentes (close-dialog, close-panel, detail-dialog): **se reemplazan completos** por las nuevas pantallas de Caja Operativa, Tesorería y Jornadas.

### Pantallas nuevas
- **`/admin/cash-session-active`** (o nombre equivalente): caja operativa activa del día. Abrir/cerrar/X-report/drops.
- **`/admin/treasury`** (Caja General): listado de movimientos paginado, registro de pagos corporativos, balance + drift.
- **`/admin/business-days`** + detalle: gestión de jornadas (close, force-close, audit).

---

## Plan por fases (revisado)

### F1 — Caja operativa de la jornada (ADMIN)
**Esfuerzo:** 4-6 días.
- Nuevo `CashSessionService` (frontend) consumiendo `/api/cash-sessions/*`.
- Pantalla "Caja Activa": ver caja OPEN actual (única), abrir si no hay, X report, drops, cierre por método.
- Modelo TypeScript `CashSession`, `CashSessionSnapshot`, `CashSessionClosePayload`, `CashSessionDropPayload`.
- Nueva entrada en `nav-config.ts` "Caja Activa" (ADMIN).
- **Criterio de éxito:** el admin abre/cierra cajas múltiples por jornada vía esta pantalla.

### F2 — Tesorería (Caja General)
**Esfuerzo:** 4-6 días.
- Nuevo `CashAccountService` consumiendo `/api/cash-accounts/*`.
- Pantalla "Tesorería": balance + tabla paginada de movimientos + form de registro (`SUPPLIER_PAYMENT` / `EXPENSE` / `ADJUSTMENT IN/OUT`).
- Sin opción `SALARY_PAYMENT` ni `DROP_IN` desde esta pantalla (backend los rechaza con 422).
- Indicador discreto de `drift` (audit-balance).
- Nueva entrada en `nav-config.ts` "Tesorería" (ADMIN).
- **Criterio de éxito:** los pagos a proveedores y gastos extraordinarios pasan por acá, no por la pantalla operativa de gastos.

### F3 — Gestión de Jornadas
**Esfuerzo:** 3-4 días.
- Nuevo `BusinessDaysService` consumiendo `/api/business-days/*`.
- Pantalla "Jornadas": listado con filtros (status, fecha, sucursal) + drill-down a cajas + acciones close / force-close (con `reason`) / audit.
- Nueva entrada en `nav-config.ts` "Jornadas" (ADMIN).
- **Criterio de éxito:** el supervisor cierra el día con esta pantalla, no con `cash-register/close` legacy.

### F4 — Rediseño dashboard administrativo
**Esfuerzo:** 3-5 días.
- Reemplazar `dashboard.component.checkCashRegisterStatus()` por composición de:
  - `cash-sessions/active` (caja del turno actual).
  - `business-days/active` (jornada en curso).
  - `cash-accounts/:id/balance` (saldo de tesorería).
- Eliminar import de `CashRegisterService` en `dashboard.component`.
- Botón "Caja" del nav apunta a la nueva pantalla F1.
- **Criterio de éxito:** dashboard renderiza sin llamar al endpoint legacy.

### F5 — Limpieza de chequeos legacy
**Esfuerzo:** 2-3 días.
- En cada uno de los ~13 consumers de `cashRegisterSvc.getDashboard()`: eliminar el chequeo previo. Si el backend rechaza con `409 NO_ACTIVE_SESSION`, mostrar el mensaje + sugerencia "abrí una caja".
- Componentes afectados: `approvals`, `commissions.facade`, `delinquency`, `delinquency-apply-dialog`, `expenses/expense-side-panel`, `payments/payment-detail-dialog` (×2), `payments/direct-payment-dialog`, `seller/credit-detail`, `seller/credit-detail/direct-payment-dialog`, `seller/credit-detail/settlement-dialog`.
- **Criterio de éxito:** ningún archivo importa `CashRegisterService` salvo el módulo legacy mismo.

### F6 — Apagar legacy + señal verde para cleanup backend
**Esfuerzo:** 1-2 días.
- Esconder o redirigir `/admin/cash-register` a `/admin/business-days`.
- Eliminar la entrada del menú "Caja" legacy.
- Audit grep: cero ocurrencias de `cash-register/dashboard`, `cash-register/pre-close`, `cash-register/close` fuera del módulo legacy.
- Esperar 14 días con logs del backend limpios.
- Señal verde al equipo backend → arrancar `feat/cash-system-cleanup` (plan en `docs/audit-cash-legacy-2026-06-02.md`).

---

## Estimación total (V4)

| Fase | Esfuerzo |
|---|---|
| F1 — Caja operativa | 4-6 días |
| F2 — Tesorería | 4-6 días |
| F3 — Jornadas | 3-4 días |
| F4 — Dashboard | 3-5 días |
| F5 — Limpieza chequeos | 2-3 días |
| F6 — Apagar legacy | 1-2 días |
| **TOTAL frontend** | **17-26 días** |

Más liviano que V3 (que estimaba 24-35) porque no se construye pantalla de cobrador ni de rendiciones.

Paralelizable: F2 puede arrancar junto con F1. F3 después de F1.

---

## Riesgos (V4)

| ID | Riesgo | Severidad | Mitigación |
|---|---|---|---|
| FR-1 | Admin recibe `409 NO_ACTIVE_SESSION` en primera aprobación del día | ALTA (UX) | F1 + F5 incluyen mensaje claro + botón "abrir caja". |
| FR-2 | Algún consumer del legacy queda olvidado y bloquea el cleanup backend | ALTA | F6 audita con grep explícito antes de la señal verde. |
| FR-3 | Deploy desincronizado (backend V4 vs frontend con check legacy) | MEDIA | Coordinar deploy o feature flag temporal. |
| FR-4 | `cash-register/conversions` sigue siendo legacy y vive en frontend | BAJA | Aceptado. Se reemplaza en el cleanup futuro. |

---

## Coordinación con backend cleanup

```
Frontend F1 → F6  ⇒  Logs limpios 14 días  ⇒  Backend cleanup arranca
```

El cleanup backend (eliminación de `cash_registers`, `cash_movements`, módulo `cashRegister`) **no debe arrancar** antes. El plan detallado del cleanup está en `docs/audit-cash-legacy-2026-06-02.md`.
