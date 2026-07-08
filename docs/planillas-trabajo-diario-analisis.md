# Análisis funcional — Generación de planillas y filtro "Trabajo Diario"

> Documento funcional (sin cambios de código todavía). Responde al requerimiento
> de `generacion-planillas-cobros.md`: clasificar todos los estados de una cuota
> respecto del trabajo de cobranza, detectar cuáles pueden quedar sin planilla o
> duplicadas, y proponer un filtro principal "Trabajo Diario" que garantice que
> nada que requiera gestión se quede sin trabajar.

---

## 1. Hallazgo principal (resumen ejecutivo)

**El motor de selección ya sabe armar el "Trabajo Diario"; el problema es de UI y de default, no de SQL.**

- El backend ya tiene el filtro `TODAY_AND_OVERDUE`, que operativamente es casi
  exactamente lo que el requerimiento pide: vencimientos de hoy + visitas de hoy
  + mora (vencidas sin agenda vigente), en una sola planilla y sin duplicados.
- **Pero la UI lo esconde a propósito.** En `generate-collection-dialog.component.ts`
  hay un comentario que dice que `TODAY_AND_OVERDUE` "devuelve prácticamente el
  mismo conjunto que TODAY". **Eso es incorrecto:** `TODAY` NO incluye la mora
  vieja; `TODAY_AND_OVERDUE` sí. Son conjuntos bien distintos.
- **El default del diálogo es `TODAY` ("Para cobrar hoy").** Por lo tanto, si el
  dueño genera todos los días la planilla por defecto, **la mora vieja sin visita
  nunca entra** salvo que además se acuerde de generar aparte "Vencidas sin agenda".
  Ese es precisamente el riesgo que el requerimiento quiere eliminar.

**Conclusión:** el "Trabajo Diario" se logra promoviendo `TODAY_AND_OVERDUE` a
filtro principal y default, con una sola ampliación menor (un caso borde, ver §4 y §6).
No hacen falta tablas nuevas, ni migraciones, ni reescribir los CTEs.

---

## 2. Cómo selecciona hoy el sistema (relevamiento)

Toda la lógica vive en `collections.queries.js → findInstallmentsForSheet(collectorId, date, filter)`.

### 2.1. Universo base — CTE `candidates`
Una cuota es "candidata" solo si cumple TODO esto:
- Crédito en estado `ACTIVE`.
- Cliente con `assigned_collector_id` = el cobrador de la planilla.
- `installment.status IN ('PENDING','PARTIAL','OVERDUE')`.
- Saldo real `> 0` (`amount_due - amount_paid`) — el saldo, no el status, es la verdad.
- **No** tiene una pre-carga de cobro `PENDING` viva (doble control: si hay un
  cobro sin aprobar/rechazar, la cuota sale del recorrido hasta que el admin resuelva).

### 2.2. Fuente de verdad de la agenda — CTE `latest_next_visit`
Por cuota, la **última** `next_visit_date` registrada (por `created_at DESC`),
unificando `payments` (PENDING/APPROVED) y `collection_attempts` (no anulados).
Es la misma fuente que usa el detalle del crédito.

### 2.3. Razones de inclusión (sub-CTEs)
Con `target = date` de la planilla:

| CTE | Definición | Qué representa |
|---|---|---|
| `scheduled_today` | visita `= target` | Visita pactada para hoy |
| `due_today` | vence `= target` **y** (sin visita **o** visita `<= target`) | Vence hoy sin compromiso futuro |
| `overdue` | vence `< target` **y** (sin visita **o** visita `<= target`) | Vencida sin agenda futura (incluye visita hoy o vencida) |
| `overdue_unscheduled` | vence `< target` **y** (sin visita **o** visita `< target`) | Vencida "pura": ni visita hoy ni futura |

### 2.4. Los 4 filtros actuales
| Valor backend | Etiqueta UI | Composición | ¿En UI? |
|---|---|---|---|
| `TODAY` | **Para cobrar hoy** (default) | `due_today` + `scheduled_today` | Sí |
| `OVERDUE` | **Vencidas sin agenda** | `overdue_unscheduled` | Sí |
| `TODAY_AND_OVERDUE` | — | `overdue` + `due_today` + `scheduled_today` | **Oculto** |
| `ALL_PENDING` | **Todas las pendientes** | todo `candidates` | Sí |

Reglas ya implementadas y correctas: una visita **futura** posterga la cuota
(pisa al vencimiento); una visita **vencida** deja de valer y la cuota vuelve a
mora; dedupe por cuota vía `ROW_NUMBER`; orden operativo por `op_priority`
(1 visita pactada · 2 mora · 3 vence hoy · 4 resto).

---

## 3. Estados posibles de una cuota y dónde debería aparecer

Dentro del universo `candidates` (crédito activo, cobrador asignado, con saldo, sin
pre-carga pendiente), toda cuota se describe por dos ejes: **vencimiento** vs. hoy y
**última visita agendada** vs. hoy.

Leyenda: V=vence, A=agenda(visita). `-`=sin visita. Futuro `>hoy`, Hoy `=hoy`, Pasado `<hoy`.

| # | Vence | Visita | Requiere gestión hoy | Trabajo Diario (propuesto) | TODAY | OVERDUE | ALL_PENDING |
|---|---|---|:--:|:--:|:--:|:--:|:--:|
| 1 | Hoy | — | Sí (vence hoy) | ✅ | ✅ | — | ✅ |
| 2 | Pasado | — | Sí (mora) | ✅ | — | ✅ | ✅ |
| 3 | cualquiera | Hoy | Sí (visita pactada hoy) | ✅ | ✅ | — | ✅ |
| 4 | Pasado | Pasado | Sí (visita vencida → mora) | ✅ | — | ✅ | ✅ |
| 5 | Hoy | Pasado | Sí (vence hoy, visita ya venció) | ✅ | ✅ | — | ✅ |
| 6 | **Futuro** | **Pasado** | **Sí (visita perdida)** | ✅ (ampliación) | — | — | ✅ |
| 7 | Pasado | Futuro | No (compromiso futuro) | — (postergada) | — | — | ✅ |
| 8 | Hoy | Futuro | No (compromiso futuro) | — (postergada) | — | — | ✅ |
| 9 | Futuro | Futuro | No | — | — | — | ✅ |
| 10 | Futuro | — | No (aún no vence) | — | — | — | ✅ |

**Lectura clave:**
- Los estados 1–5 (todo lo que hoy requiere gestión salvo el borde) ya los cubre
  `TODAY_AND_OVERDUE`. El default actual `TODAY` **se pierde los estados 2 y 4**
  (toda la mora). Por eso generar solo "Para cobrar hoy" deja mora sin trabajar.
- **Estado 6 es el hueco real:** cuota que todavía no vence pero tenía una visita
  agendada que ya pasó. No cae en ningún filtro diario; solo en "Todas las
  pendientes". Ver §6.
- Estados 7–8 (con visita futura) están **correctamente** fuera del día: la cuota
  está comprometida para otra fecha. Aparecerán solos el día de la visita.

### Estados fuera del universo (excluidos de raíz — correcto, pero con matices)
| Estado | ¿Se excluye bien? | Nota |
|---|---|---|
| `PAID` / `SETTLED` / saldo 0 | Sí | No requiere gestión |
| `PLAN_CHANGE_CANCELLED` / `WRITTEN_OFF` | Sí | Cuotas no vigentes |
| Crédito no `ACTIVE` | Sí | — |
| Pre-carga `PENDING` viva | Sí (por diseño) | **Riesgo si queda atascada** (§6) |
| Cliente **sin** cobrador asignado | Queda fuera de TODA planilla | Hay vista aparte `findUnassignedCustomersWithPending` (§6) |

---

## 4. Filtro propuesto: "Trabajo Diario"

**Definición funcional:** una cuota entra al Trabajo Diario del día `target` si es
candidata y:

> **(no tiene visita futura)** y **(ya venció, o vence hoy, o tiene una visita para
> hoy o vencida)**.

Formalmente, sobre `candidates` con `v = latest_next_visit`:
```
(v IS NULL AND due_date <= target)      -- vencidas/vencen hoy sin agenda
  OR (v <= target)                      -- visita hoy o visita vencida (cualquier vencimiento)
-- y quedan EXCLUIDAS las que tienen v > target (postergadas a esa fecha)
```

Esto es **`TODAY_AND_OVERDUE` + el estado 6** (vence futuro con visita vencida).
Cubre los estados 1–6 y excluye 7–10. Garantiza que ninguna cuota accionable se
escape: todo lo que venció, vence hoy, o tenía un compromiso para hoy/vencido,
entra; y solo se posterga lo que tiene un compromiso a futuro.

**Por qué es la planilla "que el dueño genera todos los días":** si la corre a
diario, la mora se arrastra sola (una vencida sigue apareciendo cada día hasta
gestionarse), las visitas del día entran, y las visitas perdidas no se pierden.

---

## 5. Qué hacer con los filtros actuales

| Filtro hoy | Propuesta | Motivo |
|---|---|---|
| `TODAY_AND_OVERDUE` (oculto) | **Promoverlo a "Trabajo Diario" y hacerlo el DEFAULT** (con la ampliación del estado 6) | Es el que garantiza el objetivo del requerimiento |
| `TODAY` "Para cobrar hoy" | **Conservar, renombrar a "Solo hoy (vencen o se visitan)"** y aclarar que NO incluye mora | Vista acotada útil (p. ej. un día liviano), pero deja de ser el default para no esconder la mora |
| `OVERDUE` "Vencidas sin agenda" | **Conservar tal cual** | Vista focalizada para perseguir mora pura; ya no es imprescindible para el día a día porque Trabajo Diario la incluye, pero sirve como corte específico |
| `ALL_PENDING` "Todas las pendientes" | **Conservar** como panorama/planeamiento (no operativo diario) | Único lugar donde se ven las cuotas con visita futura (estados 7–10) y el estado 6 hoy |

Sin superposiciones si se comunica el propósito de cada uno: **Trabajo Diario** = lo
del día; **Solo hoy** = subconjunto sin mora; **Vencidas sin agenda** = solo mora;
**Todas** = auditoría/panorama.

---

## 6. Casos borde donde una cuota puede escaparse hoy

1. **Vence a futuro + visita vencida (estado 6).** Visita agendada (típicamente un
   `SCHEDULED_VISIT` del admin, o una gestión sobre una cuota aún no vencida) cuya
   fecha ya pasó sin trabajarse. Hoy no aparece en ningún filtro diario. **La
   propuesta de Trabajo Diario lo incorpora** con el término `v <= target`.
2. **Pre-carga PENDING atascada.** Una cuota con un cobro sin aprobar/rechazar sale
   del recorrido (correcto, por doble control), pero si el admin nunca resuelve la
   pre-carga, la cuota queda invisible indefinidamente. No es un bug del filtro,
   pero conviene un tablero/alerta de "pre-cargas pendientes con antigüedad".
3. **Cliente sin cobrador asignado.** Sus cuotas no entran a NINGUNA planilla (el
   universo exige `assigned_collector_id`). Ya existe `findUnassignedCustomersWithPending`
   como vista aparte; el Trabajo Diario no la reemplaza. Recomendación: exponer esa
   vista como alerta visible para que nadie quede sin cobrador.
4. **Reasignación de cobrador a mitad de ciclo.** La cuota puede quedar en la
   planilla (snapshot inmutable) del cobrador viejo y a la vez entrar en la del
   nuevo → doble aparición entre planillas distintas (no dentro de una). Es un
   comportamiento conocido; escapa al alcance de este filtro pero conviene documentarlo.

---

## 7. Duplicados

- **Dentro de una misma planilla:** imposible. `selected` deduplica por
  `installment_id` con `ROW_NUMBER OVER (PARTITION BY installment_id ORDER BY incl_prio)`.
  Una cuota aparece una sola vez, con la razón de mayor prioridad.
- **Entre planillas distintas:** solo por reasignación de cobrador (caso borde 4) o
  por regenerar una planilla (los snapshots viejos son inmutables y la capa "live"
  reconcilia el estado). No es una duplicación del filtro.

---

## 8. Recomendación de implementación de menor impacto (reuso máximo)

Todo se apoya en lo que ya existe (`candidates`, `latest_next_visit`, dedupe y
orden). Cambios mínimos:

1. **Backend (SQL):** definir el Trabajo Diario reutilizando los CTEs. La forma más
   contenida es agregar un sub-CTE `visit_lapsed` (candidatas con `v < target`,
   cualquier vencimiento) y sumarlo a la composición de `TODAY_AND_OVERDUE`; o,
   equivalente y más legible, redefinir esa composición con el predicado único de §4.
   El enum del validador ya acepta `TODAY_AND_OVERDUE` (no cambia el contrato).
2. **Frontend (UI):** agregar la opción **"Trabajo Diario"** (`TODAY_AND_OVERDUE`)
   a `filterOptions`, ponerla como **default** en lugar de `TODAY`, y ajustar
   etiquetas/descripciones de los otros tres según §5. Es donde vive el bug real
   (el filtro está escondido por un comentario equivocado).
3. **Sin migraciones, sin tablas nuevas, sin tocar el snapshot de planillas.** El
   `inclusion_reason` ya soporta las razones existentes; el estado 6 puede reportar
   `reason = 'OVERDUE'` (visita vencida = volvió a mora) sin ampliar el CHECK.

**Orden sugerido:** primero cerrar este documento (definición de Trabajo Diario y
nombres de filtros). Con eso acordado, el SQL sale de una y de bajo riesgo, y el
dueño queda con la tranquilidad de que generar "Trabajo Diario" a diario no deja
ninguna cuota accionable sin trabajar.
