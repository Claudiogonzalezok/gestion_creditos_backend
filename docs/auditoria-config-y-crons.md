# Auditoría técnica — Configuración y procesos automáticos

> Basada en evidencia real del código (búsquedas + referencias cruzadas al
> 2026-07-09). Cuando un parámetro o cron no tiene uso, se indica explícitamente
> "sin referencias activas en el código".

Fuentes de verdad:
- Parámetros: `src/seeds/02_system_config.seed.js`, `DEFAULT_VALUES` en
  `src/modules/systemConfig/systemConfig.queries.js`, migración
  `src/config/migrations/004_refresh_tokens.sql`.
- Lectura de parámetros: `getValue(key)` (`systemConfig.queries.js:70`), con caché
  en memoria (TTL 5 min) → un cambio del Admin tarda hasta 5 min en reflejarse.
- Cron jobs: `src/jobs/*.job.js`, arrancados en `src/app.js:247-262`.
- Observabilidad: tabla `cron_execution_log` (migración 017) + módulo `cronLogs`.

---

# PARTE 1 — Parámetros de configuración

Inventario total: **14 parámetros**. 12 definidos en el seed + `DEFAULT_VALUES`;
**2 (`rt_expiry_*`) definidos solo en la migración 004** (ver hallazgo H1).

## 1.1 Tabla resumen

| Parámetro | Tipo | Valor | Estado | Usado en (archivo:línea) | Lógica de negocio / impacto | Recomendación |
|---|---|---|---|---|---|---|
| `commission_rate` | decimal | 0.08 | **Usado** | `credits.service.js:818` | Comisión de venta = total × tasa (al aprobar SALE) | Conservar |
| `penalty_grace_days` | int | 3 | **Usado (intensivo)** | `overdueInstallments.job.js:124`, `credits.service.js:1295,1804`, `customers.service.js:36`, `installments.service.js:58`, `payments.service.js:509,654,785`, `portal.service.js:5`, `reports.service.js:15` | Días de gracia; base de la mora derivada (`IS_OVERDUE_DERIVED`) usada en mora, saldos, planillas, reportes | Conservar (parámetro central) |
| `penalty_rate_daily` | decimal | 0.005 | **Usado** | `overdueInstallments.job.js:129` | Tasa diaria de mora compuesta (Fórmula B) | Conservar |
| `penalty_max_rate` | decimal | 0.50 | **Usado** | `overdueInstallments.job.js:126`, `installments.service.js:28` | Tope de mora acumulable (× original) | Conservar |
| `credit_expiry_days` | int | 7 | **Usado** | `creditExpiry.job.js:12` | Días en `PENDING_APPROVAL` antes de expirar | Conservar |
| `max_credit_amount` | decimal | 500000 | **Usado** | `customers.queries.js:26,124` | `payment_capacity` del cliente = max − saldo vivo | Conservar |
| `jwt_expiry_internal_hs` | int | 8 | **Usado** | `auth.service.js:22,139` | Expiración del JWT interno | Conservar |
| `jwt_expiry_portal_min` | int | 30 | **Usado** | `auth.service.js:73,183` | Expiración del JWT del portal | Conservar |
| `rt_expiry_internal_days` | int | 7 | **Usado** | `auth.service.js:23,140` | Expiración del refresh token interno | Conservar (+ ver H1) |
| `rt_expiry_portal_days` | int | 1 | **Usado** | `auth.service.js:74,184` | Expiración del refresh token del portal | Conservar (+ ver H1) |
| `login_max_attempts` | int | 3 | **Usado** | `auth.service.js:21,72` | Intentos fallidos antes del bloqueo de cuenta | Conservar |
| `commission_week_close_day` | int (día) | 6 | **Usado** | `weeklyCommissionCycle.job.js:13`, `systemConfig.service.js:53` | Día en que el cron cierra el ciclo semanal de comisiones | Conservar (ver H3) |
| `min_credit_amount` | decimal | 1000 | **Parcial** | `systemConfig.service.js:9,37,43` (rango + validación cruzada) · seed · test | **Sin uso de negocio**: NO se enforcea en la creación de créditos ni en el cotizador; solo se valida contra `max_credit_amount` al editarlo | Ver H2 |
| `commission_pay_day` | int (día) | 1 | **Parcial** | `systemConfig.service.js:48` (solo validación cruzada) | **Sin uso de negocio**: ningún proceso lo consume; la liquidación la hace el Admin manualmente | Ver H2 |

Verificado por búsqueda: no existen otros parámetros leídos por `getValue` fuera
de los listados.

## 1.2 Hallazgos

**H1 — `rt_expiry_internal_days` / `rt_expiry_portal_days` están fuera de la fuente única.**
Se usan activamente (`auth.service.js`), pero **no** están en `DEFAULT_VALUES` ni en
el seed `02_system_config.seed.js` — solo se insertan en la migración 004
(`ON CONFLICT DO NOTHING`). Consecuencias:
- `resetToDefault('rt_expiry_*')` **no funciona** (`DEFAULT_VALUES[key]` es `undefined`
  → devuelve `null`, `systemConfig.queries.js:50-52`).
- Si `getValue` no encuentra la fila (base sin la migración 004), **no hay fallback**
  → devuelve `null` y el cálculo de expiración del token puede romperse.
- **Recomendación:** agregar ambos a `DEFAULT_VALUES` y al seed 02 (mismos valores
  7 y 1) para unificar la fuente de verdad y que el reset/fallback funcionen.

**H2 — Dos parámetros "decorativos" (definidos pero sin efecto de negocio).**
- `min_credit_amount`: la UI lo muestra ("Monto mínimo en el cotizador") pero **ningún
  código lo aplica** al crear créditos. Solo se valida contra `max_credit_amount`.
- `commission_pay_day`: "Día de pago de liquidaciones", pero **ningún proceso lo lee**;
  la liquidación es manual (Admin). Solo se valida contra `commission_week_close_day`.
- **Recomendación (segura):** NO eliminarlos sin decisión de producto — la UI los
  expone y borrarlos cambiaría la pantalla de Configuración. Opciones: (a) darles
  uso real (enforce de mínimo en el alta; gatear la liquidación por `commission_pay_day`),
  o (b) marcarlos como "reservados/informativos" en la descripción para no confundir.
  **Clasificación:** reservados a futuro, no candidatos a borrado inmediato.

**H3 — Etiqueta "ISO" imprecisa en los días de comisión.**
`commission_week_close_day` (desc. "ISO: 6=Sáb") se compara con `new Date().getDay()`
(`weeklyCommissionCycle.job.js:14`), que **no es ISO** (getDay: 0=Dom..6=Sáb; ISO:
1=Lun..7=Dom). Coinciden de Lunes(1) a Sábado(6), difieren solo en Domingo (getDay 0
vs ISO 7). Con el valor por defecto 6 funciona bien, pero la etiqueta induce a error
si alguien configura "7" pensando en domingo. **Recomendación:** aclarar la descripción
(usar convención getDay) o normalizar el código a ISO.

## 1.3 Conclusión Parte 1
- **12 parámetros** con uso real y correcto → conservar.
- **2 parciales** (`min_credit_amount`, `commission_pay_day`) → reservados; decidir si
  se les da uso o se aclara que son informativos. **No borrar sin decisión de producto.**
- **Deuda de consistencia (H1):** subir `rt_expiry_*` a `DEFAULT_VALUES` + seed.
- **No se encontró código muerto duro** en parámetros (todos tienen al menos referencia
  de validación/UI).

---

# PARTE 2 — Cron jobs y automatizaciones

**Inventario completo: 6 cron jobs.** Verificado: no hay otros `cron.schedule`,
`setInterval` ni `setTimeout` recurrentes fuera de `src/jobs/` (búsqueda en `src`).
Todos se registran en `cron_execution_log` vía `runWithLogging` (`utils/cronLogger.js`),
que captura el error y **no lo re-propaga** (un cron no tira el servidor), pero **no
tiene lock** (no evita doble ejecución).

Arranque: `src/app.js:247-262` — solo si `require.main === module` **y**
`NODE_ENV !== 'test'`. Todos usan `timezone` AR (`process.env.TZ` o
`America/Argentina/Buenos_Aires`), consistente con `CURRENT_DATE` (la conexión fija
TimeZone AR en `config/db.js`).

## 2.1 Tabla resumen

| Cron (job_name) | Archivo:línea | Expresión | Horario (AR) | Propósito | Tablas leídas → modificadas | Params | Idempotente | Riesgo principal |
|---|---|---|---|---|---|---|---|---|
| **overdueInstallments** | `overdueInstallments.job.js:257` | `0 2 * * *` | 02:00 diario | Aplicar mora (catch-up) y marcar `OVERDUE` | installments, payments(PENDING) → **installments** (penalty_amount, amount_due, status, last_penalty_applied_at) | `penalty_grace_days`, `penalty_rate_daily`, `penalty_max_rate` | **Sí (fuerte)** | Financiero — ver §2.4 |
| **creditExpiry** | `creditExpiry.job.js:67` | `0 3 * * *` | 03:00 diario | Expirar créditos `PENDING_APPROVAL` viejos y liberar stock | credits, credit_products → **credits** (EXPIRED), **product_units** (RESERVED→AVAILABLE) | `credit_expiry_days` | **Sí** | Bajo |
| **tokenCleanup** | `tokenCleanup.job.js:21` | `0 4 * * *` | 04:00 diario | Borrar tokens expirados | → **token_blacklist**, **refresh_tokens** (DELETE) | — | **Sí** | Bajo (housekeeping) |
| **installmentDueSoon** | `installmentDueSoon.job.js:56` | `0 8 * * *` | 08:00 diario | Notificar cuotas que vencen en 3 días | installments, credits, customers → **(nada)** notifica | — | **No** (ver §2.4) | Notificaciones duplicadas / perdidas |
| **cashRegisterReminder** | `cashRegisterReminder.job.js:46` | `0 21 * * *` | 21:00 diario | Recordar jornadas `OPEN` sin cerrar | business_days → **(nada)** notifica | — | **No** (ver §2.4) | Notificaciones duplicadas / perdidas |
| **weeklyCommissionCycle** | `weeklyCommissionCycle.job.js:62` | `59 23 * * *` | 23:59 diario (actúa solo el día de cierre) | Reportar comisiones PENDING del ciclo | commissions, users → **(nada)** solo loguea | `commission_week_close_day` | **Sí** (no cambia estado) | Bajo (informativo) |

## 2.2 Mapa de ejecución automática (secuencia diaria, hora AR)

```
02:00  overdueInstallments   → MORA (financiero, catch-up)
03:00  creditExpiry          → expira créditos + libera stock
04:00  tokenCleanup          → borra tokens expirados
08:00  installmentDueSoon    → notifica cuotas a vencer en 3 días
21:00  cashRegisterReminder  → notifica jornadas abiertas
23:59  weeklyCommissionCycle → cierre/report del ciclo (solo si getDay()==close_day, def. Sáb)
```

- **Diario:** los 6 (todos con expresión `* * *` de día).
- **Por hora:** ninguno.
- **Semanal (efectivo):** `weeklyCommissionCycle` — corre a diario pero solo actúa el
  día configurado (`commission_week_close_day`, default Sábado).
- **Al iniciar el servidor:** se **programan** los 6 (no se ejecutan al arranque; quedan
  agendados).
- **Bajo demanda:** cada job exporta su función (`markOverdueAndApplyPenalty`,
  `expireOldCredits`, `runCleanup`, `checkInstallmentsDueSoon`, `checkOpenCashRegisters`,
  `closeWeeklyCycle`) → se pueden invocar manualmente; hay módulo `cronLogs` para auditar.

## 2.3 Crons críticos

- **overdueInstallments (02:00) — CRÍTICO (proceso financiero).** Es el único que
  modifica montos (mora sobre `installments`). Muy bien diseñado (ver §2.4).
- **creditExpiry (03:00) — semi-crítico.** Cambia estado de créditos y **libera stock**
  (product_units). Un fallo prolongado deja unidades `RESERVED` bloqueadas de más.
- **weeklyCommissionCycle — NO es crítico:** a pesar del nombre, **no cierra ni bloquea**
  comisiones; solo reporta. La liquidación real la hace el Admin manualmente.
- **installmentDueSoon / cashRegisterReminder — no críticos:** solo notificaciones push.

## 2.4 Idempotencia, riesgos y Disaster Recovery

**overdueInstallments — idempotencia y DR excelentes.**
La fuente de verdad es `installments.last_penalty_applied_at` (por cuota), NO el cron.
El job es un "reconciliador" con **catch-up**: si el VPS estuvo caído N días, la próxima
corrida aplica los N días faltantes (Fórmula B compuesta cerrada). Correr dos veces el
mismo día → `days_to_apply <= 0` → no-op. Todo en `BEGIN/COMMIT` con un único UPDATE.
`effective_today` se congela al inicio (protege contra cambios de reloj/NTP). Primera
corrida limitada a M=1 (evita "big bang"). **Ya está preparado para DR/reinicio del VPS.**

**creditExpiry / tokenCleanup — idempotentes por diseño.**
Filtran por estado/expiración (`PENDING_APPROVAL` + antigüedad; tokens vencidos). Correr
dos veces o después de un downtime → simplemente procesa lo que queda pendiente. Seguros
de reejecutar.

**installmentDueSoon / cashRegisterReminder — SIN catch-up (riesgo real de DR).**
- `installmentDueSoon` filtra `due_date = CURRENT_DATE + 3 días` (ventana de un día exacto).
  Si el VPS está **caído a las 08:00** de ese día, ese recordatorio **se pierde para siempre**
  (al día siguiente la ventana es otra fecha). No hay reintento.
- `cashRegisterReminder` es puntual a las 21:00; si el VPS está caído, no se envía.
- Ambos, si corren **dos veces** (reinicio + re-schedule, o multi-instancia), envían
  **notificaciones duplicadas** (no hay dedupe).
- Impacto: **moderado** (son avisos, no dinero), pero es el punto más débil ante reinicios.

**weeklyCommissionCycle — sin catch-up pero sin efecto de estado.**
Si está caído el día de cierre a las 23:59, se pierde el log/reporte del ciclo, pero
**no cambia datos** → sin impacto financiero. Nota: usa `getDay()` (ver H3).

## 2.5 Posibles problemas detectados

| Problema | ¿Presente? | Detalle |
|---|---|---|
| Cron duplicados (misma tarea 2×) | **No** | Cada job tiene expresión y propósito únicos |
| Horarios conflictivos | **No** | Bien espaciados (02/03/04/08/21/23:59) |
| Cron dependiente de parámetro inexistente | **No** | Todos los params leídos existen (con fallback hardcodeado en cada `getValue(...) || 'default'`) |
| Cron nunca ejecutado | **No** (en 1 instancia) | Los 6 se programan en `app.js`; **ver riesgo multi-instancia** |
| **Duplicación por multi-instancia** | **Sí (riesgo)** | Los crons son **in-process** (node-cron). Si el VPS corre el backend en **PM2 cluster / varias réplicas**, **cada instancia dispara los 6 crons** → doble mora-check (idempotente, ok), pero **notificaciones duplicadas** y doble trabajo. `runWithLogging` **no** tiene lock. |
| Inconsistencia si el VPS se reinicia | **Parcial** | overdueInstallments/creditExpiry/tokenCleanup se auto-recuperan (catch-up). `installmentDueSoon`/`cashRegisterReminder` **no** (avisos puntuales perdidos). |

## 2.6 Recomendaciones de mejora y hardening

1. **Garantizar una sola instancia de scheduler (crítico si se escala).** Correr el
   backend en PM2 **modo fork** (no cluster) para los crons, **o** mover los jobs a un
   proceso worker único, **o** agregar un **advisory lock** de Postgres en
   `runWithLogging` (`pg_advisory_xact_lock(hashtext(job_name || fecha))`) para que solo
   una instancia ejecute cada corrida. Esto elimina duplicados y notificaciones repetidas.
2. **DR para los jobs de aviso.** Para `installmentDueSoon` y `cashRegisterReminder`:
   (a) hacerlos **idempotentes** (dedupe de notificación por `entity + tipo + día` para
   que reejecutar no duplique), y (b) darles una **ventana de catch-up** (p. ej. "cuotas
   que vencen en ≤3 días y aún no notificadas hoy") para que un reinicio no pierda el aviso.
3. **Cerrar H1** (subir `rt_expiry_*` a `DEFAULT_VALUES` + seed) — evita expiraciones de
   token rotas si falta la migración 004 y habilita `resetToDefault`.
4. **Alerta sobre crons caídos.** Ya existe `cron_execution_log` + módulo `cronLogs`;
   agregar una alerta/health-check que avise si un job crítico (overdueInstallments,
   creditExpiry) **no registró corrida exitosa** en las últimas 24–48 hs.
5. **Aclarar H3** (etiqueta ISO vs `getDay()` en los días de comisión).
6. **Definir `min_credit_amount` / `commission_pay_day`** (H2): darles uso real o marcarlos
   como informativos, para que la pantalla de Configuración no prometa comportamiento
   inexistente.

## 2.7 Procesos que deberían incluir Disaster Recovery / reanudación tras reinicio

| Proceso | Estado DR actual | Acción |
|---|---|---|
| overdueInstallments (mora) | ✅ Catch-up completo vía `last_penalty_applied_at` | Ninguna (modelo de referencia) |
| creditExpiry | ✅ Auto-recupera por filtro de estado/antigüedad | Ninguna |
| tokenCleanup | ✅ Auto-recupera | Ninguna |
| installmentDueSoon | ❌ Aviso puntual, se pierde si hay downtime | Idempotencia + ventana de catch-up (rec. 2) |
| cashRegisterReminder | ❌ Aviso puntual, se pierde si hay downtime | Idempotencia + catch-up (rec. 2) |
| weeklyCommissionCycle | ⚠️ Sin catch-up pero sin efecto de estado | Bajo; opcional reportar ciclos no cerrados |
| **Todos (multi-instancia)** | ⚠️ In-process sin lock | Single-scheduler o advisory lock (rec. 1) |

---

## Objetivo final — resumen ejecutivo

- **Inventario de configuración confiable:** 14 parámetros; 12 con uso real, 2 parciales
  (`min_credit_amount`, `commission_pay_day`), 2 fuera de la fuente única (`rt_expiry_*`).
- **Inventario de automatizaciones completo:** 6 cron jobs diarios, todos in-process,
  auditados en `cron_execution_log`. Ninguno duplicado ni con horario conflictivo.
- **Código muerto / obsoleto:** no hay parámetros ni crons sin referencias; sí hay 2
  parámetros "decorativos" (H2) y una deuda de consistencia (H1).
- **Prioridad para DR / mantenimiento seguro:** (1) evitar duplicación multi-instancia,
  (2) DR de los 2 jobs de aviso, (3) alerta de crons caídos para los 2 críticos.
