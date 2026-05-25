# Modelo financiero de cuotas (installments)

Documento de referencia para entender la semántica, invariantes y patrones de
uso del módulo financiero. Sirve como mapa para devs futuros que necesiten
modificar lógica de cobranza, mora, reportes o reversión.

---

## 1. Tabla `installments` — campos clave

```
original_amount         NUMERIC(12,2)  NOT NULL   CHECK > 0      → capital original, INMUTABLE
penalty_amount          NUMERIC(12,2)  NOT NULL   DEFAULT 0      → mora acumulada
amount_due              NUMERIC(12,2)  NOT NULL                  → deuda viva
amount_paid             NUMERIC(12,2)  NOT NULL   DEFAULT 0
status                  VARCHAR(20)    NOT NULL   DEFAULT 'PENDING'
due_date                DATE           NOT NULL
last_penalty_applied_at DATE           NULL                      → último día en que el cron aplicó mora (catch-up)
```

### Invariantes (deben mantenerse SIEMPRE)

| Invariante | Quién la garantiza |
|------------|--------------------|
| `amount_due = original_amount + penalty_amount` | Convención del código (jobs, services) |
| `amount_paid <= amount_due` | DB CHECK `installments_amount_paid_check` |
| `original_amount > 0` | DB CHECK `installments_original_amount_check` |
| `penalty_amount >= 0` | DB CHECK `installments_penalty_amount_check` |

La constraint de la DB sobre `amount_paid` impide cualquier "overpay" — es la
red de seguridad final del modelo. Eso elimina la necesidad de pensar en
saldos a favor del cliente.

---

## 2. Estados (`status`)

| Estado | Significado | Quién lo asigna |
|--------|-------------|-----------------|
| `PENDING` | Cuota nueva sin pagos. | `generateInstallments` al aprobar crédito. |
| `PARTIAL` | Cuota con pagos pero saldo > 0, no vencida. | `updateInstallment` (services de cobros). |
| `OVERDUE` | Cuota vencida (saldo > 0, due_date + grace_days < hoy). | Cron de mora + `updateInstallment` (CASE en SQL). |
| `PAID` | Cuota cancelada (amount_paid >= amount_due). | `updateInstallment`, `markInstallmentAsPrepaid`, `earlyPay`, `settleAllInstallments`. |
| `REFINANCED` | Cuota absorbida en una refinanciación. | `markAsRefinanced` (migration 016). |

### Diagrama de transiciones

```
                  ┌─────────────┐
                  │  PENDING    │
                  └──┬─────┬──┬─┘
                     │     │  │
       cron+grace ──>│     │  │<── pago parcial
       (OVERDUE)    │     │  │     (PARTIAL si dentro de gracia,
                     │     │  │      OVERDUE si fuera)
                     v     │  v
                  ┌─────────────┐
                  │  OVERDUE    │<──┐
                  └──┬──────────┘   │
                     │              │ revertir cobro sobre
       cobro parcial │              │ cuota vencida
       sigue OVERDUE │              │ (restoreInstallmentFromReversal)
       (anti-osc.)   │              │
                     v              │
                  ┌─────────────┐   │
                  │  PARTIAL    │───┘
                  └──┬──────────┘
                     │  pago final
                     v
                  ┌─────────────┐    ┌──────────────┐
                  │  PAID       │    │  REFINANCED  │
                  └─────────────┘    └──────────────┘
                       ▲                    ▲
                       │                    │
                  pago total          markAsRefinanced
                                      (terminal — no vuelve)
```

PAID y REFINANCED son **estados terminales financieros**: la lógica de mora,
adelantos, reportes operativos y saldos los excluye explícitamente.

---

## 3. Fórmula B — cálculo de mora diaria

Decisión arquitectónica oficial (validada en `auditoria.md`):

```
base_mora_diaria = amount_due - amount_paid             # saldo pendiente REAL
delta_mora_dia   = base × penalty_rate_daily
penalty_nueva    = LEAST(penalty + delta, cap)
cap              = original_amount × penalty_max_rate
amount_due_nueva = original_amount + penalty_nueva       # mantiene invariante
```

### Por qué Fórmula B (sobre saldo) y no sobre capital fijo

- Si el cliente pagó parcialmente, la base baja **al instante** → mora siguiente
  se calcula sobre el saldo realmente debido.
- Es matemáticamente equivalente a la Fórmula A (mora sobre original) en el
  caso `amount_paid >= penalty_amount` (que es el caso normal).
- Difiere en el caso extremo `amount_paid < penalty_amount`: B compone mora
  sobre mora dentro del cap; A no.
- Decisión documentada: usar B con cap estricto sobre `original`. El cap
  limita la composición.

### Defaults del sistema (`system_config`)

```
penalty_grace_days = 3       # días de gracia antes de aplicar mora
penalty_rate_daily = 0.005   # 0.5% diario sobre el saldo
penalty_max_rate   = 0.50    # cap total = 50% del original
```

Todos modificables por Admin desde `/api/system-config`.

---

## 4. Status persistido vs vencidez derivada

El campo `status='OVERDUE'` es un **snapshot operativo/visual**. La lógica
financiera **no debe depender exclusivamente de él**:

| Cuándo usar `status='OVERDUE'` | Cuándo usar derivada |
|-------------------------------|----------------------|
| UI: badges, filtros de planilla, vistas operativas. | Lógica financiera: mora, reportes, saldos. |
| Endpoints admin de mora manual (`applyPenalty`). | Cualquier query nueva sin razón fuerte. |

### Helper canónico: `IS_OVERDUE_DERIVED`

`src/utils/installmentSql.js`:

```js
IS_OVERDUE_DERIVED('i', '$1')
// → "(i.due_date < (CURRENT_DATE - ($1)::int * INTERVAL '1 day')
//     AND (i.amount_due - i.amount_paid) > 0
//     AND i.status NOT IN ('PAID','REFINANCED'))"
```

Garantiza:
- Vencidez basada en `due_date` real, no en si corrió el cron.
- Saldo > 0 (excluye cuotas con status colgado).
- Excluye terminales (`PAID`, `REFINANCED`).

Usado en: `reports.queries.js`, `customers.queries.js`, `portal.queries.js`.

### Otros helpers SQL (`src/utils/installmentSql.js`)

| Helper | SQL devuelto | Uso |
|--------|--------------|-----|
| `REAL_REMAINING_BALANCE('i')` | `(i.amount_due - i.amount_paid)` | Saldo pendiente real. |
| `REMAINING_CAPITAL('i')` | `GREATEST(original - GREATEST(paid - penalty, 0), 0)` | Capital aún no pagado (descontando mora absorbida). |
| `IS_OVERDUE_DERIVED('i', '$N')` | Booleano compuesto | Vencidez derivada. |

---

## 5. Política de operaciones financieras

### `waivePenalty` (condonar mora)

Validaciones del service (en orden):
1. **404** si la cuota no existe.
2. **409** si `status === 'PAID'`: "La cuota ya fue cancelada. La condonación
   retroactiva generaría saldo a favor no soportado por el sistema."
   Razón: bajar `amount_due` mientras `amount_paid` queda alto violaría la
   constraint `amount_paid <= amount_due`. Para revertir cobros sobre cuotas
   pagadas, usar el flujo de reversión de payments.
3. **409** si `penalty_amount === 0`: nada que condonar.
4. Procede: `amount_due = original_amount`, `penalty_amount = 0`, status
   recalculado con CASE según due_date + grace_days y amount_paid.

### `earlyPay` (cobro anticipado directo)

Doble validación de status:
1. **Fast-path** en el service: chequea status fuera de la transacción para
   fallar rápido sin tomar lock.
2. **Safety-path** en la query: `SELECT ... FOR UPDATE` lee también `status`
   y vuelve a chequear. Si entre ambos puntos otro flujo pagó la cuota
   (cobro concurrente, cron, etc.), el inner check tira 409 y la transacción
   hace ROLLBACK.

Patrón aplicable a cualquier operación que modifique cuotas bajo concurrencia.

### `updateInstallment` (cobros aprobados)

`status` se calcula con CASE en SQL en lugar de JS — esto permite que el
recálculo use el `due_date` real de la fila (no un snapshot de JS) y
mantiene la lógica consistente sin viajes de ida y vuelta:

```sql
status = CASE
  WHEN $newPaid >= amount_due                                     THEN 'PAID'
  WHEN due_date < (CURRENT_DATE - ($grace)::int * INTERVAL '1 day') THEN 'OVERDUE'
  WHEN $newPaid > 0                                                THEN 'PARTIAL'
  ELSE 'PENDING'
END
```

Consecuencia importante: un pago parcial sobre cuota vencida **NO degrada** a
PARTIAL — sigue OVERDUE. Esto previene la oscilación `OVERDUE → PARTIAL →
OVERDUE` que tenía el código viejo.

### `restoreInstallmentFromReversal` (revertir un cobro)

Mismo patrón de CASE en SQL. Si tras restar el monto revertido la cuota sigue
vencida, vuelve a OVERDUE (no degrada a PENDING o PARTIAL).

---

## 6. Cron de mora — rol, catch-up y observabilidad

### `src/jobs/overdueInstallments.job.js`

Corre todos los días a las 02:00 ART. **Una sola operación atómica** (CTE
+ UPDATE) que marca OVERDUE y aplica mora en el mismo statement.

### Fuente de verdad: `installments.last_penalty_applied_at`

El campo `last_penalty_applied_at` (migration 018) registra el último día en
que **esa cuota** recibió mora. Es la base del cálculo de catch-up:

```
mora_start = GREATEST(
  COALESCE(last_penalty_applied_at, due_date + grace_days) + 1,
  due_date + grace_days + 1
)
M = effective_today - mora_start + 1
```

Si `M > 0`, se aplica Fórmula B compuesta cerrada en una sola operación:

```sql
penalty_new = LEAST(
  penalty + saldo × (POWER(1 + r, M) − 1),
  original_amount × max_rate
)
amount_due              = original_amount + penalty_new
last_penalty_applied_at = effective_today    -- ← SOLO si M > 0
```

### Invariante crítica: actualizar `last_penalty_applied_at` SOLO si M > 0

Si una cuota dentro de gracia (M=0) quedara marcada como "procesada hoy",
perdería días legítimos de mora al salir de gracia (el próximo cálculo
arrancaría desde hoy en lugar de desde `due_date + grace_days + 1`).

El SQL del job filtra explícitamente `WHERE days_to_apply > 0` antes del
UPDATE — las cuotas en gracia, ya pagadas, REFINANCED o con cap alcanzado
**no se tocan** en absoluto.

### Catch-up de N días en una sola corrida

Si el cron estuvo caído 5 días, la próxima corrida exitosa aplica los 5 días
de mora compuesta en una sola operación atómica. La fórmula closed-form es
matemáticamente equivalente al loop diario:

```
saldo_n     = saldo_0 × (1 + r)^n
delta_total = saldo_0 × ((1 + r)^N − 1)
```

### Saldo actual, no histórico

El catch-up usa el **saldo de HOY** (no reconstruido día por día). Si hubo
pagos durante el downtime, el saldo actual es menor y se sub-aplica mora —
favorece al cliente. Decisión consciente y defensible.

### Primera corrida del sistema

Si `cron_execution_log` no tiene registro previo exitoso, el job limita
`M = 1` para evitar "big bang" al bootstrap. La corrida queda registrada,
y desde la siguiente el catch-up real opera con M correcto.

### Congelamiento de `effective_today`

`CURRENT_DATE` se captura **una sola vez** al inicio del job y se pasa como
parámetro. Protege contra cambios de reloj/NTP/timezone durante la ejecución.

### Atomicidad

Todo el job corre dentro de `BEGIN/COMMIT`. Si algo falla → `ROLLBACK` →
ninguna `last_penalty_applied_at` se mueve → el próximo run reaplica el
catch-up correctamente. Idempotente y resiliente incluso si `cron_execution_log`
se corrompe o se pierde — la verdad financiera vive en la propia cuota.

### Importante

- El cron **no es la fuente de verdad** de vencimiento. La lógica crítica usa
  `IS_OVERDUE_DERIVED`. Si el cron se cae N días, las cuotas que se hayan
  vencido en ese tiempo igual son detectadas correctamente por reportes y
  saldos — y al volver, el cron las pone al día con catch-up automático.

### Observabilidad

Tabla `cron_execution_log` (migration 017) registra cada corrida:
- `job_name`, `started_at`, `finished_at`, `success`, `affected_rows`,
  `error_message`, `metadata` (JSONB).
- Wrapper `runWithLogging` (`src/utils/cronLogger.js`) instrumenta los 4 jobs
  (overdue, creditExpiry, tokenCleanup, weeklyCommissionCycle).
- Endpoints admin: `GET /api/admin/cron-logs` (lista filtrable) y
  `GET /api/admin/cron-logs/summary` (estado por job: OK / ERROR / RUNNING /
  NO_RUN_TODAY).

---

## 7. Exclusión de REFINANCED en queries críticas

Cuotas en estado `REFINANCED` representan deuda ya absorbida en una nueva
operación. Toda query de saldo, mora, planilla o reporte operativo las
excluye explícitamente:

```sql
WHERE status NOT IN ('PAID','REFINANCED')
```

Lista de queries que aplican este filtro:
- `payments.queries.js`: `countPendingInstallments`, `getTotalPendingBalance`,
  `getPendingInstallmentsFrom`, `shiftInstallmentDates`.
- `reports.queries.js`: portfolio active balance, top customers, summary
  executive portfolio.

El helper `IS_OVERDUE_DERIVED` también las excluye en su componente
`status NOT IN ('PAID','REFINANCED')`.

---

## 8. Testing

### Estrategia mixta

- **Unit** (`src/**/*.test.js`): mocks de `pool.query`. Para services sin
  lógica financiera, controllers, validators, cronLogger.
- **Integration** (`tests/integration/**`): Postgres real vía docker-compose.
  Para SQL financiero, formula de mora, transiciones de status, locks.

**Regla**: nunca mockear fórmulas financieras ni SQL. Si tocás algo en este
módulo, agregá test de integration.

Ver `tests/README.md` para detalles operativos.

---

## 9. Trampas conocidas / antipatrones

- ❌ Usar `i.status = 'OVERDUE'` en queries de reporte/portal: depende del
  cron habiéndose ejecutado. Usar `IS_OVERDUE_DERIVED`.
- ❌ Calcular mora sobre `original_amount` fijo: ignora pagos parciales. Usar
  saldo real (`amount_due - amount_paid`).
- ❌ Llamar `waivePenalty` para revertir un cobro: usar `payments.reverse`.
- ❌ Modificar `amount_due` sin recomputar desde `original + penalty`: rompe
  invariante.
- ❌ Promise.all sobre el mismo `client` de pg: causa "client.query while
  another query in flight" — usar `pool` o secuencial.
- ❌ Validar status fuera de la transacción sin revalidarlo bajo `FOR UPDATE`:
  abre ventana de TOCTOU. Patrón: fast-path + safety-path.
