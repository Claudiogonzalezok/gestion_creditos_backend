# Plan de cambios — Modelo Operativo de Caja V4

**Fuente de verdad:** `analisis-caja.md` V4 (taxativo).
**Diferencia respecto a V3:** se elimina toda la entidad de rendiciones (`collection_settlements`, `settlement_id`, `settled_at`). La aprobación de la cobranza ES el acto formal de recepción del dinero.

---

## 1. Resumen ejecutivo

| Dimensión | Antes (V2) | Después (V4) |
|---|---|---|
| `cash_session` representa | Caja personal de un usuario | Caja operativa de la jornada |
| Invariante de unicidad | Una OPEN por `owner_user_id` | Una OPEN por `business_day_id` |
| `owner_user_id` semántica | Dueño contable del dinero | Responsable operativo del turno (campo se conserva) |
| Pre-carga (cobrador) | Requiere caja OPEN propia | NO requiere caja |
| Aprobación | Solo valida jornada | Imputa a caja activa de la jornada |
| `adminDirect`, `reverse`, `expenses.create`, `credits.approve`, `cashRegister.createConversion` | Imputan a caja del admin | Imputan a caja activa de la jornada |
| Rendición física del cobrador | (no modelado) | **NO se modela.** Aprobación = recepción. |
| Jornada al cerrar última caja | Auto → READY_TO_CLOSE definitivo | Auto → READY_TO_CLOSE reversible (vuelve a OPEN si se abre nueva caja) |
| Cierre formal de jornada | Manual (sin cambio) | Manual (sin cambio) |
| Caja General + commissions | Cumplido en Fase 3 ✓ | Sin cambio |
| Frontend cobradores | (planeado F1 "Mi caja") | **Sin cambios** (V4 explícito) |
| Frontend admin | (planeado F1-F6) | F1 redefinido como "Caja del turno"; F2/F3 sin cambio; sin "Rendiciones" |

**Magnitud:** ~8 commits backend + 1 migración nueva + ajuste de ~10 suites de tests integration. Cero entidades nuevas en DB. Cero endpoints nuevos.

---

## 2. Mapeo directiva V4 → cambio técnico

| # | Directiva V4 | Componente afectado | Acción |
|---|---|---|---|
| 1.1 | Jornada puede tener múltiples cajas | Migración 027 (índice) + `cashSessions.service.open` | Cambiar invariante |
| 1.2 | Caja NO representa usuario | `cash_sessions.owner_user_id` (semántica) | COMMENT + documentación; sin rename |
| 1.3 | Cobradores no administran cajas | `payments.service.create` | Quitar check `findOpenByOwner` |
| 2 | Una OPEN por business_day | Migración 027 | Reemplazar índice único parcial |
| 3 | Caja General intacta | (Fase 3 cumplido) | Sin cambio |
| 4 paso 1 | Pre-carga sin caja | `payments.service.create` | Quitar check + `cash_session_id` queda NULL al crear |
| 4 paso 3 | Aprobación imputa a caja activa | `payments.service.approve` | Resolver `findActiveSessionByBusinessDay`, setear `cash_session_id` en approve |
| 4 — Regla fundamental | NO rendiciones, NO settlement | (nada que agregar; V3 había planteado tablas que ahora NO se crean) | Confirmar que el plan V3 queda descartado |
| 5 READY_TO_CLOSE reversible | `cashSessions.service.open` + `business_days.queries` | Si jornada está READY_TO_CLOSE, revertir a OPEN al abrir nueva caja |
| 5 Cierre definitivo manual | `business_days.queries.maybeTransitionToReadyToClose` | Mantener transición auto a READY_TO_CLOSE (es informativa, no terminal). Cierre formal sigue siendo manual. |
| 6 Apertura: no exista otra OPEN en la jornada | `cashSessions.service.open` | Reemplazar check |
| 7 Imputación a caja activa | `payments` (approve/adminDirect/reverse), `expenses.create`, `credits.approve`, `cashRegister.createConversion` | Migrar al nuevo helper |
| 7 Eliminar findOpenByOwner / lockOpenSessionForUser | `cashSessions.queries` | Marcar @deprecated → eliminar al final |
| 8 Mantener tablas existentes | DB | Cero tablas nuevas, cero tablas eliminadas |
| 8 owner_user_id sigue (semántica nueva) | DB | COMMENT explícito |
| 9 Frontend cobradores sin cambios | Frontend | Plan F1 "Mi caja" se elimina del roadmap |
| 9 Admin: caja operativa, apertura/cierre/arqueos, Caja General, jornadas | Frontend | Pantallas nuevas (alineadas con F2/F3 ya planeados + caja activa única) |

---

## 3. Plan de schema

### 3.1 Migración 027 — Invariante de unicidad por jornada

`027_cash_sessions_v4_invariant.sql`

**Pre-requisito de datos (verificación previa obligatoria):**

```sql
-- ABORTAR la migración si esta query devuelve > 0 filas:
SELECT business_day_id, COUNT(*)
FROM cash_sessions
WHERE status = 'OPEN'
GROUP BY business_day_id
HAVING COUNT(*) > 1;
```

Si existen cajas OPEN paralelas, acción operativa antes de migrar: forzar `markPending` o cerrar todas excepto una por jornada.

**Cambios DDL:**

1. `DROP INDEX IF EXISTS one_open_session_per_owner_idx;`
2. `CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_per_business_day_idx ON cash_sessions(business_day_id) WHERE status='OPEN';`
3. `ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS shift_label VARCHAR(40) NULL;` (opcional, identificador del turno).
4. `COMMENT ON COLUMN cash_sessions.owner_user_id IS 'V4: responsable operativo del turno. NO representa al dueño del dinero ni al cobrador.';`

Idempotente. No se crea ninguna tabla nueva. No se modifica `payments`. No se crea `collection_settlements`.

---

## 4. Plan de servicios (backend)

### 4.1 `cashSessions.queries`

| Función | Acción |
|---|---|
| `findOpenByOwner(ownerUserId, db?)` | Marcar `@deprecated`. Mantener temporalmente. Eliminar en V4.6. |
| `lockOpenSessionForUser(client, ownerUserId)` | Marcar `@deprecated`. Idem. |
| `findActiveSessionByBusinessDay(businessDayId, db = pool)` | NUEVO. Devuelve la caja OPEN única de la jornada (o `null`). |
| `lockActiveSessionByBusinessDay(client, businessDayId)` | NUEVO. Con `SELECT ... FOR UPDATE` para uso dentro de tx. |

### 4.2 `cashSessions.service`

| Función | Cambio |
|---|---|
| `open` | (1) Reemplazar `findOpenByOwner(ownerUserId)` por `findActiveSessionByBusinessDay(businessDay.id)`. (2) Si la jornada está en `READY_TO_CLOSE`, revertir a `OPEN` dentro de la misma tx. (3) `owner_user_id` se llena con `requestingUser.id` por compat — significa "cajero responsable del turno". |
| `close` | Sin cambio funcional. |
| `markPending`, `reconcile`, `addDrop`, `reverseDrop`, `snapshot`, `getActive`, `getById`, `getAll` | Sin cambios. |

### 4.3 `business_days.queries`

| Función | Cambio |
|---|---|
| `maybeTransitionToReadyToClose` | Sin cambio funcional. Sigue siendo informativa. |
| `revertToOpen(client, businessDayId)` | NUEVO. Transición `READY_TO_CLOSE → OPEN`. Idempotente. Usado por `cashSessions.service.open`. |
| `close`, `forceClose`, `audit`, `findActiveJornadaDate`, `isJornadaMutable`, `findAll` | Sin cambios. |

### 4.4 `payments.service`

| Función | Cambio |
|---|---|
| `create` (pre-carga) | Eliminar check `cashSessionsQueries.findOpenByOwner(requestingUser.id)`. NO setear `cash_session_id` al insertar. Eliminar el `withTransaction` introducido en IMP-2 (ya no hace falta envolver). |
| `approve` | Resolver caja activa: `lockActiveSessionByBusinessDay(client, jornada.id)` dentro de la tx. Si no hay → 409 `NO_ACTIVE_SESSION`. Setear `payments.cash_session_id = activeSession.id` en el UPDATE. |
| `adminDirect` | Mismo cambio. Eliminar `findOpenByOwner(adminId)`. |
| `reverse` | Mismo cambio. Imputación a caja activa al momento del reverso (puede ser jornada distinta del cobro original). |
| `reject` | Sin cambio. |

### 4.5 `expenses.service`

| Función | Cambio |
|---|---|
| `create` | Reemplazar `findOpenByOwner(requestingUser.id)` por `lockActiveSessionByBusinessDay(client, jornada.id)`. Si no hay → 409. |
| `update`, `remove` | Sin cambio (IMP-7 sigue valiendo). |

### 4.6 `credits.service.approve`

Reemplazar `findOpenByOwner` y `lockOpenSessionForUser` por `findActiveSessionByBusinessDay` y `lockActiveSessionByBusinessDay`. Si requiere imputación (downPayment > 0 o prepaid > 0) y no hay caja activa → 409.

### 4.7 `cashRegister.service.createConversion` (legacy)

Mismo patrón: `lockActiveSessionByBusinessDay`.

### 4.8 `commissions.service`

Sin cambio. Cumple V4 desde Fase 3.4.

---

## 5. APIs

### 5.1 Endpoints modificados (sin cambio de contrato externo)

| Endpoint | Cambio observable |
|---|---|
| `POST /api/cash-sessions` | Falla 409 si ya hay otra OPEN en **la jornada** (antes era por owner). |
| `POST /api/payments` | Ya NO falla 409 "abrí caja antes". |
| `POST /api/payments/:id/approve` | Puede fallar con 409 `NO_ACTIVE_SESSION` si no hay caja operativa. |
| `POST /api/payments/admin-direct`, `/reverse` | Mismo cambio. |
| `POST /api/expenses` | Mismo cambio. |
| `POST /api/credits/:id/approve` (con enganche o prepaid) | Mismo cambio. |
| `POST /api/cash-register/conversions` (legacy) | Mismo cambio. |
| `GET /api/cash-sessions/active` | Devuelve la caja activa de la jornada del día (única). |

### 5.2 Endpoints nuevos

Ninguno. V4 no requiere endpoints nuevos.

### 5.3 Endpoints sin cambio

`/api/cash-accounts/*`, `/api/business-days/*`, `/api/commissions/*`, drops, snapshot, audit-balance.

---

## 6. Plan de migración por fases

| Fase | Descripción |
|---|---|
| **V4.1** — Helpers nuevos (aditivo) | Agregar `findActiveSessionByBusinessDay` y `lockActiveSessionByBusinessDay`. `findOpenByOwner` y `lockOpenSessionForUser` quedan `@deprecated`. Sin breaking change. |
| **V4.2** — Liberar pre-carga | `payments.service.create` no exige caja del cobrador. Tests adaptados. |
| **V4.3** — Imputación a caja activa | `payments.approve/adminDirect/reverse`, `expenses.create`, `credits.approve`, `cashRegister.createConversion` migran al nuevo helper. 409 si no hay caja activa. |
| **V4.4** — `open` con regla nueva | Reescribir chequeo de unicidad + reversión READY_TO_CLOSE → OPEN. |
| **V4.5** — Migración 027 | Drop índice viejo + create índice nuevo + COMMENT. Verificación previa de datos. |
| **V4.6** — Cleanup deprecados | Eliminar `findOpenByOwner` y `lockOpenSessionForUser`. Verificar grep. |
| **V4.7** — Documentación | Actualizar `CLAUDE.md` con V4. Persistir `docs/cash-model-v4.md`. Plan frontend V4. |

---

## 7. Tests

### 7.1 Suites integration a adaptar (~10)

`cash-sessions.test.js`, `cash-sessions-integration.test.js`, `cash-session-toctou.test.js`, `business-days.test.js`, `management-status-hook.test.js`, `planillas-capa-live.test.js`, `restore-from-reversal.test.js`, mocks de unit (`payments.service.test.js`, `credits.service.test.js`, `cashRegister.service.test.js`).

### 7.2 Suites integration nuevas

- `cash-sessions-multi-shift.test.js`
- `payments-imputation-v4.test.js`

---

## 8. Decisiones de diseño cerradas

1. No hay rendiciones como entidad.
2. `owner_user_id` se conserva. Semántica nueva via COMMENT.
3. Reversión imputa a caja activa actual.
4. Pre-carga sin caja: sí, sin condiciones.
5. Aprobación sin caja activa: 409 `NO_ACTIVE_SESSION`.
6. Deploy: atómico, sin feature flag.
7. Una sola caja OPEN por jornada.
8. Quien abre la caja: ADMIN.
9. READY_TO_CLOSE reversible.
10. Cierre formal de jornada: manual.

---

## 9. Impacto sobre el plan de migración Frontend

V4 simplifica el plan F1-F6 original:

- F1 "Mi caja" para cobradores → **Eliminada.** Cobradores sin cambios.
- F1' (V4) "Caja del turno" para ADMIN → única pantalla para abrir/cerrar la caja operativa del día.
- F2 (Tesorería) y F3 (Jornadas) sin cambio.
- F4 (Dashboard) adaptado: el card pasa a "hay caja activa hoy".
- F5 (Limpieza chequeos legacy) sin cambio.
- F6 (Apagar legacy) sin cambio.
- F7 (V3) "Rendir cobranzas" → **Eliminada.**

---

## 10. Riesgos

| ID | Riesgo | Severidad | Mitigación |
|---|---|---|---|
| V4-R1 | Migración 027 falla si hay cajas OPEN paralelas | ALTA | Verificación previa + ventana de mantenimiento |
| V4-R2 | Admin recibe 409 NO_ACTIVE_SESSION en primera aprobación | ALTA (UX) | Mensaje claro + botón "abrir caja" en frontend |
| V4-R3 | Algún flujo queda con `findOpenByOwner` | ALTA | Grep post-V4.6: cero ocurrencias |
| V4-R4 | Cobrador con caja OPEN viejo queda colgado | MEDIA | Migración opcional cierra cajas de cobradores |
| V4-R5 | Frontend desincronizado | ALTA | Deploy coordinado |
| V4-R6 | Tests existentes asumen `openSessionFor(cobrador)` | MEDIA | Adaptación masiva al inicio de V4.2 |
| V4-R7 | `cashRegister.createConversion` sigue funcional | BAJA | Cambio incluido en V4.3 |
| V4-R8 | Reportes externos ven NULLs en `payments.cash_session_id` PENDING | BAJA | Documentar |

---

## 11. Checklist de aceptación final

**Base de datos**
- [ ] Migración 027 aplicada.
- [ ] No quedan cajas OPEN paralelas en ninguna jornada.
- [ ] Comentario semántico en `owner_user_id`.

**Backend**
- [ ] `findOpenByOwner` y `lockOpenSessionForUser` eliminados.
- [ ] `findActiveSessionByBusinessDay` y `lockActiveSessionByBusinessDay` operativos.
- [ ] `payments.service.create` sin check de caja.
- [ ] `payments.approve/adminDirect/reverse` imputan a caja activa.
- [ ] `expenses.create`, `credits.approve`, `cashRegister.createConversion` imputan a caja activa.
- [ ] `cashSessions.open` aplica "una OPEN por jornada" + revierte READY_TO_CLOSE.

**Tests**
- [ ] Suite integration y unit verdes.
- [ ] Bloques nuevos: `cash-sessions-multi-shift`, `payments-imputation-v4`.

**Documentación**
- [ ] `CLAUDE.md` actualizado.
- [ ] `docs/cash-model-v4.md` persistido.
- [ ] Plan frontend V4 actualizado.

**Coordinación**
- [ ] Deploy backend + frontend coordinado.
- [ ] Comunicación al equipo.

---

## 12. Estimación de esfuerzo

| Fase | Esfuerzo |
|---|---|
| V4.1 — Helpers nuevos | 0.5 día |
| V4.2 — Liberar pre-carga | 1 día |
| V4.3 — Imputación a caja activa | 1.5 días |
| V4.4 — `open` con regla nueva | 1 día |
| V4.5 — Migración 027 | 0.5 día |
| V4.6 — Cleanup deprecados | 0.5 día |
| V4.7 — Documentación | 0.5 día |
| **TOTAL backend** | **~5.5 días** |
| Frontend | 4-6 días |

~10 días totales para equipo backend + frontend coordinado.
