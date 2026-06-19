# Modelo Operativo de Caja V4 — Referencia oficial

**Estado:** vigente.
**Implementado en:** rama `feat/cash-model-v4` (commits V4.1 → V4.7), extendido en sesiones posteriores (V4.8: una sola caja por jornada — migración 037; V4.9: operar Caja General sin jornada abierta + `MANUAL_INCOME` — migración 038).
**Fuente original de directivas:** `analisis-caja.md` (V4).
**Auditoría legacy + cleanup:** `docs/audit-cash-legacy-2026-06-02.md`.

Este documento es la fuente de verdad arquitectónica del módulo de Caja. Toda implementación futura debe respetarlo. Si una decisión técnica contradice este documento, debe modificarse la implementación — no el modelo.

---

## 1. Principios

### 1.1 Jornada (`business_days`)

La **jornada** es el día contable del negocio. Una jornada por `(business_date, branch_id)` — restricción UNIQUE.

**Máquina de estados:**
```
OPEN ──► READY_TO_CLOSE ──► CLOSED ──► AUDITED
 ▲           │
 └───────────┘
 (reversible: si se abre una nueva caja
  estando en READY_TO_CLOSE)
```

### 1.2 Caja operativa (`cash_sessions`)

La **caja operativa** es la caja de la jornada.

⚠️ **Cambio de invariante (V4.8 / migración 037):** una jornada tiene **una sola caja, siempre** — sin importar su status (`OPEN`, `PENDING_RECONCILIATION` o `CLOSED`). El modelo original (V4.1–V4.7) permitía turnos secuenciales (caja A cierra → caja B abre en la misma jornada); el negocio confirmó que esa flexibilidad no se usaba y se eliminó. **Una vez cerrada la caja de la jornada, no se puede abrir otra para esa misma jornada.**

```sql
-- Reemplaza al índice parcial de V4.5 (one_open_session_per_business_day_idx)
CREATE UNIQUE INDEX one_session_per_business_day_idx
    ON cash_sessions(business_day_id);
```

Tiene:
- Apertura (`opened_at`, `opened_by`, `opening_amount`).
- Cierre (`closed_at`, `closed_by`, `closure_snapshot` JSONB inmutable).
- Arqueo declarado por método (`cash_session_closure_details`).
- Responsable operativo (`owner_user_id` = **cajero del turno**, NO el dueño del dinero).
- Drops opcionales hacia Caja General (`cash_session_drops`).

**No** representa: un cobrador, un dueño del dinero, una caja personal de usuario.

**Máquina de estados:**
```
OPEN ──► CLOSED
  │
  └───► PENDING_RECONCILIATION ──► CLOSED
```

### 1.3 Cobradores

Los cobradores **NO** administran cajas. No abren, no cierran, no arquean. Son actores operativos de campo:

```
Sale a cobrar  →  Registra cobranzas  →  Regresa
```

Las cobranzas se registran como **pre-cargas (`payments` status `PENDING`)** sin necesidad de caja abierta. El cobrador trae el efectivo físico; el admin lo recibe y aprueba.

### 1.4 Aprobación = recepción del dinero

Una cobranza `APPROVED` implica que **el dinero ya fue recibido por la empresa**. La aprobación es el acto formal de recepción.

**No existe** entidad separada de rendición. **No existe** `collection_settlement`. **No existe** `settled_at`. **No existe** flujo de rendiciones.

### 1.5 Caja General (`cash_accounts`)

La **Caja General** es la tesorería consolidada del negocio. No representa una caja operativa, ni un turno, ni un usuario. **Es independiente de la jornada**: existe y opera sin importar si hay o no una caja operativa abierta.

**Ingresos:**
- Drops desde cajas operativas (`DROP_IN` automático).
- Ajustes administrativos (`ADJUSTMENT IN`).
- Ingresos extraordinarios / aportes de capital (`MANUAL_INCOME` — V4.9, ver §1.6).

**Egresos:**
- Pagos a proveedores (`SUPPLIER_PAYMENT`).
- Pago de servicios y gastos corporativos (`EXPENSE`, vía `criteria: 'COMPANY'` — ver §1.6).
- Liquidación de sueldos y comisiones (`SALARY_PAYMENT`, generado por `commissions.liquidate`).
- Ajustes contables (`ADJUSTMENT OUT`).

**Regla:** los gastos importantes **no** deben salir de cajas operativas. Las cajas operativas solo administran la operatoria diaria.

`current_balance` está cacheado en `cash_accounts` con `CHECK (current_balance >= 0)` a nivel DB. Es un **pool único** — no separa efectivo de transferencia a nivel de saldo total (sí guarda el split `amount_cash`/`amount_transfer` por movimiento, a fines de reporte).

### 1.6 Operar sin jornada abierta — patrón `criteria: 'DAILY' | 'COMPANY'` (V4.9)

Gasto, ingreso manual y conversión **no requieren una caja operativa abierta**. Cada uno de estos tres flujos acepta un `criteria` que decide el destino:

| `criteria` | Destino | Requiere caja operativa OPEN |
|---|---|---|
| `DAILY` (default) | Caja activa de la jornada | Sí — `409 NO_ACTIVE_SESSION` si no hay |
| `COMPANY` | Caja General directa | No |

El frontend (`cash-register.component`, `expense-side-panel.component`) deshabilita la opción `DAILY` y defaultea a `COMPANY` cuando no hay sesión activa, pero la decisión real vive en el backend — `criteria: 'COMPANY'` funciona aunque haya o no caja abierta.

**Gasto (`POST /api/expenses`, `source: 'COMPANY'`):** ver `expenses.service.create`. Inserta `EXPENSE OUT` directo en `cash_account_movements` vía `insertMovementWithBalance`, sin tocar `cash_sessions`.

**Ingreso manual a Caja General:** no tiene endpoint dedicado — se usa el genérico `POST /api/cash-accounts/:id/movements` con `movement_type: 'MANUAL_INCOME'` (frontend: `CashRegisterService.createManualIncomeCompany`).

**Conversión (`POST /api/cash-register/conversions`, `criteria: 'COMPANY'`):** ver `cashRegister.service.createConversion`. Como `current_balance` es un pool único, una conversión CASH↔TRANSFER en Caja General tiene **delta neto 0** — no inserta ningún movimiento en `cash_account_movements`, solo valida que el monto no supere el saldo disponible. Por eso una conversión COMPANY **no aparece** en el reporte de Movimientos de Caja General (§5.3): no generó ningún movimiento real, solo se validó. Sigue visible en el tab "Cash Conversions Report" (que lee de otra fuente).

⚠️ El check de "jornada legacy cerrada" (`cashRegister.queries.findByDate`) **solo aplica a la rama `DAILY`** de `createConversion`. Una rama `COMPANY` que reusara ese chequeo quedaría bloqueada por una jornada legacy cerrada sin motivo — bug real encontrado y corregido en esta misma sesión.

### 1.7 `MANUAL_INCOME` (migración 038)

Nuevo `movement_type` de `cash_account_movements`, dirección fija `IN`. Se usa para ingresos extraordinarios / aportes de capital a Caja General que no provienen de un drop, una venta ni una liquidación. Acepta split `amount_cash` / `amount_transfer` (incluido de un solo lado — solo efectivo o solo transferencia, ver §6 inv. #5).

---

## 2. Flujo de cobranzas (paso a paso)

```
┌─────────────────────────────────────────────────────────────┐
│ PASO 1 — Cobrador en la calle                                │
│ POST /api/payments (rol COLLECTOR / SELLER_COLLECTOR)        │
│   · status = 'PENDING'                                       │
│   · cash_session_id = NULL                                   │
│   · NO requiere caja abierta                                 │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ PASO 2 — Cobrador regresa, entrega efectivo                  │
│ (acción física, no modelada en sistema)                      │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ PASO 3 — Admin aprueba (== recibe el dinero)                 │
│ POST /api/payments/:id/approve (rol ADMIN)                   │
│   · Resuelve caja activa de la jornada (lockActiveSession-   │
│     ForCurrentJornada). Si no hay → 409 NO_ACTIVE_SESSION.   │
│   · status = 'APPROVED'                                      │
│   · cash_session_id = caja activa                            │
│   · Se imputa el ingreso a la caja                           │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ PASO 4 — Cierre del turno                                    │
│ POST /api/cash-sessions/:id/close                            │
│   · declared por método (CASH, TRANSFER, ...)                │
│   · genera closure_snapshot inmutable                        │
│   · diferencia declared vs expected                          │
│   · Jornada transita a READY_TO_CLOSE (reversible)           │
│   · Al cerrar, NO se puede volver a abrir otra caja para     │
│     esta misma jornada (V4.8 — ver §1.2)                     │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼  (opcional, en cualquier momento del turno)
┌─────────────────────────────────────────────────────────────┐
│ DROP a Caja General                                          │
│ POST /api/cash-sessions/:id/drops                            │
│   · cash_session_drops crea entrada ACTIVE                   │
│   · cash_account_movements genera DROP_IN auto               │
│     en la cuenta destino (vía service.addDrop)               │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Distribución de responsabilidades

### Cobrador (`COLLECTOR`, `SELLER_COLLECTOR`)
**Puede:** registrar cobranzas (pre-cargas), consultar cobranzas propias.
**No puede:** abrir caja, cerrar caja, aprobar cobranzas, registrar gastos, liquidar pagos, operar Caja General.

### Administrador (`ADMIN`)
**Puede:** abrir caja, operar caja, arquear, cerrar caja, realizar drops, aprobar cobranzas, revertir cobros, registrar gastos, liquidar comisiones, operar Caja General (con o sin jornada abierta — §1.6), cerrar jornadas, auditar jornadas, forzar cierre de jornada con cajas PENDING.

---

## 4. Reglas de imputación (servicio)

Toda operación `DAILY` que impacte una caja debe utilizar la **caja activa de la jornada**. Gasto, ingreso manual y conversión tienen además la salida directa a Caja General (`criteria: 'COMPANY'`, §1.6) que no pasa por este chequeo.

### Endpoints que imputan a la caja activa (rama DAILY)
- `payments.approve`
- `payments.adminDirect`
- `payments.reverse`
- `expenses.create` (cuando `source` no es `'COMPANY'`)
- `credits.approve` (cuando hay enganche o cuotas prepagadas)
- `cashRegister.createConversion` (cuando `criteria` no es `'COMPANY'`)

### Helper canónico
```js
const cashSessionsQueries = require('../cashSessions/cashSessions.queries');

await withTransaction(async (client) => {
  const activeSession = await cashSessionsQueries.lockActiveSessionForCurrentJornada(client);
  if (!activeSession) {
    throw {
      status: 409,
      message: 'No hay caja operativa abierta. Abrí una caja para continuar.',
      code: 'NO_ACTIVE_SESSION',
    };
  }
  // ... resto del flujo con activeSession.id como cash_session_id
});
```

### Helpers prohibidos
- `findOpenByOwner(...)` — **eliminado** en V4.6.
- `lockOpenSessionForUser(...)` — **eliminado** en V4.6.
- Cualquier variante basada en el usuario que ejecuta la acción.

---

## 5. Caja General — operación

### 5.1 Lectura
```
GET /api/cash-accounts                    listar cuentas activas
GET /api/cash-accounts/:id                detalle
GET /api/cash-accounts/:id/balance        current_balance cacheado
GET /api/cash-accounts/:id/audit-balance  { cached, computed, drift }
GET /api/cash-accounts/:id/movements      libro paginado / filtrable
```

### 5.2 Escritura pública (ADMIN)
```
POST /api/cash-accounts/:id/movements
  body: { movement_type, amount, amount_cash?, amount_transfer?, description?, beneficiary_name?, direction? }
```

- `movement_type` admitidos por endpoint público: `SUPPLIER_PAYMENT`, `EXPENSE`, `ADJUSTMENT`, `MANUAL_INCOME` (V4.9).
- `SALARY_PAYMENT` **no** se acepta por endpoint público — se genera únicamente vía `commissions.liquidate` (trazabilidad de período).
- `DROP_IN` **no** se acepta por endpoint público — se genera únicamente vía `cashSessions.service.addDrop` (trazabilidad de origen).
- `ADJUSTMENT` requiere `direction` explícito (IN / OUT). `MANUAL_INCOME` tiene dirección fija `IN`.
- `amount_cash` / `amount_transfer` (split): permitido para `ADJUSTMENT IN` y `MANUAL_INCOME`. Acepta un solo lado (solo efectivo o solo transferencia) — el único requisito es que ambos sean `>= 0` y la suma sea `> 0`. **No** hace falta que "ambos sean mayores a 0" (esa restricción era un bug — ver §6 inv. #5).
- Regla universal: cualquier movimiento que llevaría `current_balance < 0` es rechazado con `409 INSUFFICIENT_BALANCE`.

### 5.3 Escrituras automáticas
- `cashSessions.addDrop` → genera `DROP_IN` en la misma tx.
- `cashSessions.reverseDrop` → genera `ADJUSTMENT OUT` compensatorio.
- `commissions.liquidate` → genera `SALARY_PAYMENT` con `beneficiary_name = empleado`.

### 5.4 Reporte — Movimientos de Caja General (V4.9)

`GET /api/reports/general-cash-movements?date_from&date_to` lee directo de `cash_account_movements` (cuenta `type='GENERAL_CASH'`), sin pasar por jornada ni sesión. Devuelve `{ summary: { total_movements, total_in, total_out }, rows: [...] }` con todos los tipos: `DROP_IN`, `SUPPLIER_PAYMENT`, `SALARY_PAYMENT`, `EXPENSE`, `ADJUSTMENT`, `MANUAL_INCOME`.

En el frontend, el tab "Movimientos de Caja" (`/admin/reports`) tiene un toggle de **ámbito**:
- **Caja x Jornada** (default): comportamiento original, requiere elegir una jornada → caja.
- **Caja General**: usa este endpoint, no requiere jornada ni caja.

Esto cierra un gap real que existía antes de V4.9: gasto y conversión `COMPANY` se veían en pantallas sueltas (`/admin/expenses`, "Cash Conversions Report") pero `MANUAL_INCOME` no se veía en **ninguna** pantalla — solo afectaba el `current_balance` agregado, sin rastro auditable. Excepción: una conversión `COMPANY` sigue sin generar movimiento (§1.6), por diseño — no es un gap, no hubo plata que registrar.

---

## 6. Invariantes verificables

| # | Invariante | Dónde se enforce |
|---|---|---|
| 1 | Una jornada tiene una sola caja, siempre (no solo "una OPEN") | Índice único total `one_session_per_business_day_idx` (V4.8 / migración 037) + service `cashSessions.open` vía `findAnySessionByBusinessDay` |
| 2 | Una jornada por `(business_date, branch_id)` | UNIQUE constraint en `business_days` |
| 3 | Pre-cargas no requieren caja del cobrador | `payments.service.create` no consulta caja (V4.2) |
| 4 | Aprobaciones / gastos / reversos / enganches / conversiones `DAILY` imputan a caja activa | servicios usan `lockActiveSessionForCurrentJornada` (V4.3) |
| 4b | Gasto / ingreso manual / conversión `COMPANY` operan sin caja activa, directo a Caja General | `criteria`/`source: 'COMPANY'` en los 3 flujos (V4.9, §1.6) |
| 5 | `cash_accounts.current_balance >= 0` | `CHECK` constraint a nivel DB (CRIT-3) + validación en `insertMovementWithBalance`. El split `amount_cash`/`amount_transfer` admite un solo lado (>= 0 cada uno, suma > 0) — no exige que ambos sean > 0 |
| 6 | `cash_account_movements` es append-only | No hay endpoints UPDATE / DELETE; correcciones vía ADJUSTMENT |
| 7 | `current_balance` reconstruible desde movimientos | Migración 025 lo inicializa así; helper `recomputeBalance`; endpoint `audit-balance` expone drift |
| 8 | Snapshot del cierre es inmutable | `closure_snapshot` JSONB v1 frozen al close |
| 9 | Drops generan DROP_IN automático en misma tx | `cashSessions.addDrop` (Fase 3.3) |
| 10 | Reverso de drop puede fallar si Caja General sin fondos | `ADJUSTMENT OUT` pasa por regla universal; si rechazada, toda la tx revierte |
| 11 | Liquidación de comisiones imputa a Caja General, no a caja operativa | `commissions.liquidate` (Fase 3.4) |
| 12 | Cobradores no pueden abrir/cerrar/arquear/aprobar | Routes con `authorize('ADMIN')` para operaciones de caja |

---

## 7. Errores estándar

| HTTP | Code | Cuándo |
|---|---|---|
| `409` | `NO_ACTIVE_SESSION` | Intento de aprobar / gastar / convertir con `criteria: 'DAILY'` sin caja activa en la jornada |
| `409` | `ACTIVE_SESSION_IN_BUSINESS_DAY` | Intento de abrir caja cuando ya existe una caja (de cualquier status) en la jornada |
| `409` | `INSUFFICIENT_BALANCE` | Caja General sin fondos para un movimiento OUT (o conversión `COMPANY`) |
| `409` | `NO_GENERAL_CASH_ACCOUNT` | Operación `COMPANY` cuando no existe una Caja General activa |
| `409` | `ACCOUNT_INACTIVE` | Movimiento intenta operar sobre `cash_account` con `is_active = FALSE` |
| `422` | `INVALID_MOVEMENT_TYPE` | `movement_type` no aceptado por el endpoint público (`DROP_IN`, `SALARY_PAYMENT`) |
| `422` | `INVALID_DIRECTION` | `ADJUSTMENT` sin `direction` |
| `422` | `INVALID_SPLIT_DIRECTION` | `amount_cash`/`amount_transfer` en un movimiento que no es `IN` |
| `422` | `INVALID_SPLIT_AMOUNT` | `amount_cash` o `amount_transfer` negativo (o ambos en 0) |
| `422` | `INVALID_SPLIT_TOTAL` | `amount` no coincide con `amount_cash + amount_transfer` |
| `422` | `INVALID_AMOUNT` | `amount <= 0` |

---

## 8. Legacy — qué queda vivo y por qué

Tras V4.6 los helpers `findOpenByOwner` y `lockOpenSessionForUser` fueron eliminados. Pero el módulo `cashRegister` y la tabla `cash_movements` siguen existiendo en modo compat:

| Componente | Razón de mantenerlo |
|---|---|
| `cash_registers` (tabla) | Dashboard antiguo del frontend la consume. |
| `cash_movements` (tabla) | `payments.service` la sigue poblando para alimentar el dashboard legacy. |
| Módulo `src/modules/cashRegister/` | Endpoints públicos `GET /api/cash-register/*` siguen expuestos; también vive ahí `createConversion`. |
| `cashRegister.service.createConversion` | Único endpoint legacy aún vivo con lógica de negocio nueva (rama `DAILY` migrada a `lockActiveSessionForCurrentJornada` en V4.3; rama `COMPANY` agregada en V4.9). |

**Eliminación definitiva:** prevista en la rama futura `feat/cash-system-cleanup`. Pre-requisito: el frontend deja de consumir `/api/cash-register/*`. Ver `docs/audit-cash-legacy-2026-06-02.md` para el plan detallado de 7 pasos.

---

## 9. Si algo se quiere cambiar

Si el modelo operativo del negocio cambia (ej: aparece la necesidad real de rendiciones cross-jornada, o multi-sucursal, o turnos secuenciales de vuelta), este documento debe actualizarse **primero**, y la implementación lo sigue. Cualquier código que contradiga este modelo es un bug por definición.
