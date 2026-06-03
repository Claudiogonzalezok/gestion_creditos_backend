# Plan ejecutivo — Migración Frontend al nuevo modelo de Caja

**Fecha:** 2026-06-02
**Repo frontend:** `D:\gestion-creditos-f` (Angular + PrimeNG)
**Estado:** plan inicial — pendiente auditoría real del código frontend antes de ejecutar.

> ⚠️ Las pantallas listadas en la sección 3 son **estimaciones** basadas en el shape de los endpoints legacy. Antes de arrancar F1 se debe hacer una auditoría del repo frontend para identificar el inventario exacto de consumers y ajustar las fases si hace falta.

## 1. Objetivo

Migrar el frontend Angular para que deje de consumir los endpoints legacy de `cash_registers`/`cash_movements` y pase a usar exclusivamente el modelo nuevo (`cash-sessions`, `business-days`, `cash-accounts`). El éxito de esta migración es **prerrequisito** para arrancar `feat/cash-system-cleanup` en el backend.

## 2. Mapeo conceptual

| Concepto operativo | Endpoint legacy (hoy) | Endpoint nuevo (target) | Cambio para el UX |
|---|---|---|---|
| Dashboard del día | `GET /api/cash-register/dashboard` | Composición de `GET /api/cash-sessions?business_date=…` + `GET /api/cash-accounts/:id/balance` | Pasa de "vista única del día" a "lista de cajas del día + saldo de tesorería". Más rico. |
| Pre-cierre | `GET /api/cash-register/pre-close` | `GET /api/cash-sessions/:id/snapshot` (X report) | Por caja, no agregado del día. El frontend muestra una tabla por cada cobrador. |
| Cierre del día | `POST /api/cash-register/close` | Dos pasos: cada usuario `POST /cash-sessions/:id/close` con `declared` por método; después supervisor `POST /business-days/:id/close` | Cambio de modelo: cierre es per-caja, no per-día. Supervisor confirma al final. |
| Apertura de caja | — (implícito en legacy) | `POST /api/cash-sessions` con `opening_amount` | Antes era invisible; ahora explícito. Cada cobrador abre antes de operar. |
| Cierre con caja olvidada | `force: true` en close legacy | `POST /api/business-days/:id/force-close` con `reason` | Habilitar botón "cerrar jornada con deuda" en pantalla de supervisor. |
| Conversiones efectivo↔transferencia | `POST /api/cash-register/conversions` | Sigue vivo en legacy hasta cleanup (no se removió) | Sin cambio inmediato. Se moverá a `cash-sessions` en cleanup futuro. |
| Liquidación de comisiones | `POST /api/commissions/liquidate` (sin cambio de URL) | Idem | El backend ya no exige caja OPEN del admin (Fase 3.4). El frontend puede **eliminar** el check "abrí caja antes". |
| Pagos corporativos (proveedor/sueldo/gasto extraordinario) | No existía como concepto separado | `POST /api/cash-accounts/:id/movements` | Pantalla nueva: "Tesorería → Movimientos de Caja General". |
| Saldo Caja General | No existía | `GET /api/cash-accounts/:id/balance` + `/audit-balance` | Pantalla nueva: "Saldo tesorería" con drift opcional. |

## 3. Inventario probable de pantallas afectadas

No es el árbol completo del frontend, es una estimación basada en el shape de los endpoints legacy. La auditoría real del repo frontend la pendiente.

Áreas que casi seguro tocan:
- **Dashboard administrativo** — consume `cash-register/dashboard`. Necesita rediseño.
- **Modal/pantalla de cierre de caja** — consume `cash-register/close`. Reemplazo completo (dos flujos: cobrador cierra su caja, supervisor cierra jornada).
- **Historial de cierres** — lista de `cash_registers`. Reemplazo por listado de `business_days` + drill-down a cajas.
- **Liquidación de comisiones** — chequea caja OPEN del admin → eliminar ese check.
- **Gestión de gastos** (`expenses`) — sin cambio de endpoint pero ahora `update`/`delete` puede devolver 409 con razón `cash_session.status='CLOSED'` además del legacy → adaptar mensajes.

Pantallas completamente nuevas:
- **Tesorería / Caja General** — listado de movimientos paginado/filtrable, registro de pago (SUPPLIER/EXPENSE/ADJUSTMENT), audit-balance.
- **Apertura de caja del operador** — pantalla pre-trabajo donde el cobrador/admin abre su sesión con monto inicial.
- **Gestión de jornada (admin)** — listado de business_days, cierre, force-close, auditoría.

## 4. Plan de migración por fases

Pensado en fases pequeñas y desplegables independientemente, cada una verificable en producción antes de pasar a la siguiente.

### Fase F1 — Habilitar apertura/cierre de caja (cobradores)
**Duración estimada:** 3-5 días.
- Pantalla "Mi caja" para cobradores: ver caja activa (`GET /cash-sessions/active`), abrir (`POST /cash-sessions`), ver X report (`GET /:id/snapshot`).
- Mensaje claro cuando una operación de cobro falla con 409 "abrí una caja antes" (ya devuelto por el backend).
- Modal de cierre por método (`declared` array): cada cobrador declara cuánto entrega en cash y transfer; muestra diferencia.
- Sin cambios al dashboard administrativo todavía.
- **Criterio de éxito:** todos los cobradores abren y cierran su propia caja diariamente sin tocar el cierre legacy del admin.

### Fase F2 — Pantalla de Tesorería (Caja General)
**Duración estimada:** 4-6 días.
- Listado de cuentas (`GET /cash-accounts`) — hoy solo una.
- Detalle con `current_balance` + drift (audit-balance) discreto.
- Tabla paginada de movimientos con filtros por type/direction/fecha.
- Form de registro de movimiento: SUPPLIER_PAYMENT / EXPENSE / ADJUSTMENT (IN/OUT). El backend ya bloquea SALARY_PAYMENT manual (IMP-6) y validará saldo (CRIT-3 + service).
- **Criterio de éxito:** los pagos a proveedores y gastos corporativos pasan por esta pantalla, no por el modal de "gastos" del módulo `expenses` (que sigue siendo para gastos operativos del cobrador).

### Fase F3 — Gestión de jornadas (supervisor/admin)
**Duración estimada:** 3-4 días.
- Listado `GET /business-days` con filtros por status/sucursal/rango.
- Detalle con cajas de la jornada (status counts, drill-down).
- Botón "Cerrar jornada" → `POST /:id/close` (solo habilitado si status=READY_TO_CLOSE).
- Botón "Forzar cierre" → `POST /:id/force-close` con prompt obligatorio para `reason`. Habilitado si hay cajas PENDING.
- Botón "Auditar" → `POST /:id/audit` (status=CLOSED).
- **Criterio de éxito:** el supervisor cierra la jornada del día con esta pantalla, no con el `cash-register/close` legacy.

### Fase F4 — Rediseño del dashboard administrativo
**Duración estimada:** 5-7 días.
- Reemplazar el dashboard del día por una vista compuesta:
  - Resumen de jornada actual (de `business_days/:id`).
  - Lista de cajas activas con su snapshot.
  - Saldo de Caja General.
  - Métricas de cobranzas/gastos operativos.
- Eliminar consumo de `GET /api/cash-register/dashboard`.
- **Criterio de éxito:** el dashboard renderiza sin llamar al endpoint legacy.

### Fase F5 — Limpieza de mensajes y flujos secundarios
**Duración estimada:** 2-3 días.
- Liquidación de comisiones: eliminar el check "abrí una caja antes" en el front (el backend ya no lo requiere).
- Mensajes de error de `expenses.update`/`.remove`: adaptar al texto nuevo del 409.
- Quitar cualquier referencia a "cierre de caja del día" como acción del admin operativo (queda solo el de jornada).
- **Criterio de éxito:** no quedan llamadas a `cash-register/*` en el código del frontend salvo `POST /conversions` (todavía vivo).

### Fase F6 — Verificación final + señal verde para cleanup backend
**Duración estimada:** 1-2 días.
- Auditar el frontend (grep por `cash-register`) para confirmar que solo queda `/conversions`.
- Logs del backend en producción durante 1-2 semanas: chequear que `GET /api/cash-register/dashboard`, `GET /pre-close`, `POST /close` ya no reciben tráfico.
- Cuando los logs estén limpios: enviar señal al equipo backend → arrancar `feat/cash-system-cleanup`.

## 5. Estrategia de coexistencia y rollback

- **Convivencia:** durante F1–F4, los endpoints legacy siguen funcionando en el backend. Si una pantalla nueva falla, se vuelve a la vieja sin tocar el server.
- **Feature flag (opcional pero recomendado):** wrap cada pantalla nueva detrás de un flag (ej. `featureCajaSessions=true`) para activar gradualmente por usuario/rol antes del rollout total.
- **Rollback por fase:** cada fase es un PR independiente. Si una fase rompe algo, se revierte sin afectar las anteriores.
- **No tocar `/conversions` hasta cleanup:** explícitamente fuera del scope de esta migración. Se moverá cuando se rediseñe la conversión efectivo↔transferencia como parte del cleanup.

## 6. Criterios de éxito globales

1. Todos los cobradores abren y cierran su caja propia diariamente (F1).
2. Los pagos a proveedores y gastos extraordinarios pasan por Caja General, no por la pantalla operativa de gastos (F2).
3. El cierre del día lo hace el supervisor sobre `business_days`, no sobre `cash_registers` (F3).
4. Dashboard administrativo renderiza sin llamar al endpoint legacy (F4).
5. Cero llamadas frontend a `/api/cash-register/dashboard`, `/pre-close`, `/close` durante 14 días corridos (F6).
6. El frontend nunca recibe 500 por flujo legacy roto durante la migración.

## 7. Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| Resistencia operativa: los cobradores no quieren abrir caja antes de cobrar | F1 incluye onboarding/training. El mensaje 409 del backend es claro y guía al usuario. |
| Doble cierre durante coexistencia (admin cierra legacy + supervisor cierra jornada) | Documentar claramente: si se usa F3 (jornada), no debe usarse el cierre legacy. Eventualmente F5 esconde el botón legacy. |
| Conversiones siguen en legacy → quedan "huérfanas" visualmente | Aceptable. En cleanup posterior se rediseñan como parte de `cash-sessions`. |
| Frontend olvida algún consumer del legacy → cleanup backend lo rompe | F6 (auditoría + logs) es el gate explícito. No arrancar cleanup hasta que los logs estén limpios. |
| Cambios al snapshot v1 (post-cleanup) rompen al frontend | El snapshot vive en `cash_sessions.closure_snapshot`. Si el frontend lee de ahí, debe ser tolerante a campos faltantes (`outflows.commissions` se irá). |

## 8. Coordinación con backend cleanup

Esta migración del frontend habilita el siguiente trabajo en backend (rama `feat/cash-system-cleanup`, plan de 7 pasos detallado en `docs/audit-cash-legacy-2026-06-02.md`):

```
Frontend F1 → F6  ⇒  Logs limpios 14 días  ⇒  Backend cleanup arranca
```

El cleanup no debe arrancar antes. Hacerlo prematuramente rompe el dashboard antiguo y deja al frontend sin respuesta.

## 9. Estimación total

- **Esfuerzo:** ~3-4 semanas de un dev frontend full-time (puede paralelizarse F2 + F3 si hay dos devs).
- **Calendario propuesto:** F1 → F2 → F3 → F4 → F5 → F6 secuencial recomendado para reducir blast radius.
- **Punto de no retorno:** F4 (cuando se elimina el dashboard antiguo). Antes de eso todo es reversible sin tocar nada.

## 10. Próximo paso inmediato

**Auditar el repo frontend** (`D:\gestion-creditos-f`) para:
- Confirmar el inventario real de pantallas/componentes que consumen `cash-register/*` y `cash_movements`.
- Identificar consumers indirectos vía servicios compartidos.
- Ajustar la fase F3 / F4 si el dashboard tiene dependencias no contempladas acá.
- Validar la estimación de esfuerzo contra el código real.

Hasta que esa auditoría no se haga, las fases y duraciones de este plan son estimativas — sirven como marco de discusión, no como cronograma firme.
