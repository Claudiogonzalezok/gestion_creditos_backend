# Modelo Operativo de Caja V4 — Referencia oficial

**Estado:** vigente.
**Implementado en:** rama `feat/cash-model-v4` (commits V4.1 → V4.7).
**Fuente original de directivas:** `analisis-caja.md` (V4).
**Plan de implementación:** `docs/cash-model-v4-plan.md`.
**Auditoría legacy + cleanup:** `docs/audit-cash-legacy-2026-06-02.md`.

Este documento es la fuente de verdad arquitectónica del módulo de Caja. Toda implementación futura debe respetarlo. Si una decisión técnica contradice este documento, debe modificarse la implementación — no el modelo.

---

## 1. Principios

### 1.1 Jornada (`business_days`)

La **jornada** es el día contable del negocio. Una jornada por `(business_date, branch_id)` — restricción UNIQUE.

Una jornada puede contener **N aperturas y cierres de caja** durante el día. Ejemplo:

```
Jornada 2026-06-03 (HQ)
├── Caja #1   08:00 → 12:00   (cajero A)
├── Caja #2   16:00 → 22:00   (cajero B)
└── Caja #3   23:00 → 04:00   (cajero C)
```

Las tres pertenecen a la misma jornada. La jornada **no se cierra automáticamente** al cerrar una caja: solo el cierre formal manual la marca como `CLOSED`.

**Máquina de estados:**
```
OPEN ──► READY_TO_CLOSE ──► CLOSED ──► AUDITED
 ▲           │
 └───────────┘
 (reversible: si se abre una nueva caja
  estando en READY_TO_CLOSE)
```

### 1.2 Caja operativa (`cash_sessions`)

La **caja operativa** es una instancia física y temporal de operación dentro de una jornada.

Tiene:
- Apertura (`opened_at`, `opened_by`, `opening_amount`).
- Cierre (`closed_at`, `closed_by`, `closure_snapshot` JSONB inmutable).
- Arqueo declarado por método (`cash_session_closure_details`).
- Responsable operativo (`owner_user_id` = **cajero del turno**).
- Drops opcionales hacia Caja General (`cash_session_drops`).

**No** representa:
- Un cobrador.
- Un dueño del dinero.
- Una caja personal de usuario.

**Regla de unicidad obligatoria:**

```
UNIQUE OPEN CASH SESSION PER BUSINESS DAY
```

Materializada en DB como:

```sql
CREATE UNIQUE INDEX one_open_session_per_business_day_idx
    ON cash_sessions(business_day_id) WHERE status='OPEN';
```

Solo puede existir **una caja `OPEN` simultáneamente por jornada**. Cajas secuenciales en la misma jornada son válidas; cajas paralelas no.

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

Si el modelo operativo evoluciona y se necesita "el dinero llegó pero todavía no se aprobó", se modela como pre-carga `PENDING` (sin caja imputada) hasta que se apruebe.

### 1.5 Caja General (`cash_accounts`)

La **Caja General** es la tesorería consolidada del negocio. No representa una caja operativa, ni un turno, ni un usuario.

**Ingresos:**
- Drops desde cajas operativas (DROP_IN automático).
- Ajustes administrativos (ADJUSTMENT IN).
- Ingresos extraordinarios.

**Egresos:**
- Pagos a proveedores (SUPPLIER_PAYMENT).
- Pago de servicios y gastos corporativos (EXPENSE).
- Liquidación de sueldos y comisiones (SALARY_PAYMENT, generado por `commissions.liquidate`).
- Ajustes contables (ADJUSTMENT OUT).

**Regla:** los gastos importantes **no** deben salir de cajas operativas. Las cajas operativas solo administran la operatoria diaria.

`current_balance` está cacheado en `cash_accounts` con `CHECK (current_balance >= 0)` a nivel DB.

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
**Puede:** abrir caja, operar caja, arquear, cerrar caja, realizar drops, aprobar cobranzas, revertir cobros, registrar gastos, liquidar comisiones, operar Caja General, cerrar jornadas, auditar jornadas, forzar cierre de jornada con cajas PENDING.

---

## 4. Reglas de imputación (servicio)

Toda operación que impacte una caja debe utilizar la **caja activa de la jornada**.

### Endpoints que imputan a la caja activa
- `payments.approve`
- `payments.adminDirect`
- `payments.reverse`
- `expenses.create`
- `credits.approve` (cuando hay enganche o cuotas prepagadas)
- `cashRegister.createConversion` (legacy, aún vivo)

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

### Lectura
```
GET /api/cash-accounts                    listar cuentas activas
GET /api/cash-accounts/:id                detalle
GET /api/cash-accounts/:id/balance        current_balance cacheado
GET /api/cash-accounts/:id/audit-balance  { cached, computed, drift }
GET /api/cash-accounts/:id/movements      libro paginado / filtrable
```

### Escritura pública (ADMIN)
```
POST /api/cash-accounts/:id/movements
  body: { movement_type, amount, description?, beneficiary_name?, direction? }
```

- `movement_type` admitidos por endpoint público: `SUPPLIER_PAYMENT`, `EXPENSE`, `ADJUSTMENT`.
- `SALARY_PAYMENT` **no** se acepta por endpoint público — se genera únicamente vía `commissions.liquidate` (trazabilidad de período).
- `DROP_IN` **no** se acepta por endpoint público — se genera únicamente vía `cashSessions.service.addDrop` (trazabilidad de origen).
- `ADJUSTMENT` requiere `direction` explícito (IN / OUT).
- Regla universal: cualquier movimiento que llevaría `current_balance < 0` es rechazado con `409 INSUFFICIENT_BALANCE`.

### Escrituras automáticas
- `cashSessions.addDrop` → genera `DROP_IN` en la misma tx.
- `cashSessions.reverseDrop` → genera `ADJUSTMENT OUT` compensatorio.
- `commissions.liquidate` → genera `SALARY_PAYMENT` con `beneficiary_name = empleado`.

---

## 6. Invariantes verificables

| # | Invariante | Dónde se enforce |
|---|---|---|
| 1 | Una caja `OPEN` por jornada simultánea | Índice único parcial `one_open_session_per_business_day_idx` (V4.5) + service `cashSessions.open` (V4.4) |
| 2 | Una jornada por `(business_date, branch_id)` | UNIQUE constraint en `business_days` |
| 3 | Pre-cargas no requieren caja del cobrador | `payments.service.create` no consulta caja (V4.2) |
| 4 | Aprobaciones / gastos / reversos / enganches / conversiones imputan a caja activa | 5 services usan `lockActiveSessionForCurrentJornada` (V4.3) |
| 5 | `cash_accounts.current_balance >= 0` | `CHECK` constraint a nivel DB (CRIT-3) + validación en `insertMovementWithBalance` |
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
| `409` | `NO_ACTIVE_SESSION` | Intento de aprobar / gastar / convertir sin caja activa en la jornada |
| `409` | `ACTIVE_SESSION_IN_BUSINESS_DAY` | Intento de abrir caja cuando ya hay una OPEN en la jornada |
| `409` | `INSUFFICIENT_BALANCE` | Caja General sin fondos para un movimiento OUT |
| `409` | `ACCOUNT_INACTIVE` | Movimiento intenta operar sobre `cash_account` con `is_active = FALSE` |
| `422` | `INVALID_MOVEMENT_TYPE` | `movement_type` no aceptado por el endpoint público (DROP_IN, SALARY_PAYMENT) |
| `422` | `INVALID_DIRECTION` | `ADJUSTMENT` sin `direction` |
| `422` | `INVALID_AMOUNT` | `amount <= 0` |

---

## 8. Legacy — qué queda vivo y por qué

Tras V4.6 los helpers `findOpenByOwner` y `lockOpenSessionForUser` fueron eliminados. Pero el módulo `cashRegister` y la tabla `cash_movements` siguen existiendo en modo compat:

| Componente | Razón de mantenerlo |
|---|---|
| `cash_registers` (tabla) | Dashboard antiguo del frontend la consume. |
| `cash_movements` (tabla) | `payments.service` la sigue poblando para alimentar el dashboard legacy. |
| Módulo `src/modules/cashRegister/` | Endpoints públicos `GET /api/cash-register/*` siguen expuestos. |
| `cashRegister.service.createConversion` | Único endpoint legacy aún vivo con lógica de negocio (migrado a `lockActiveSessionForCurrentJornada` en V4.3). |

**Eliminación definitiva:** prevista en la rama futura `feat/cash-system-cleanup`. Pre-requisito: el frontend deja de consumir `/api/cash-register/*`. Ver `docs/audit-cash-legacy-2026-06-02.md` para el plan detallado de 7 pasos.

---

## 9. Si algo se quiere cambiar

Si el modelo operativo del negocio cambia (ej: aparece la necesidad real de rendiciones cross-jornada, o multi-sucursal, o cajas paralelas), este documento debe actualizarse **primero**, y la implementación lo sigue. Cualquier código que contradiga este modelo es un bug por definición.
