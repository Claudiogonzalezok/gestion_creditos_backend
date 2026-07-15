# Análisis — ¿Planillas de cobranza para usuarios ADMIN?

> Contexto: los dueños del negocio (Tadeo Heredia y Samuel Ruiz) son ADMIN en
> producción y además operan en la calle (Samuel es zona de cobranza con 94
> créditos). Hoy el sistema solo genera planillas para roles
> `COLLECTOR`/`SELLER_COLLECTOR`, lo que fuerza a darles una **segunda cuenta**
> operativa. Propuesta de Dante: **una sola cuenta ADMIN por persona, que pueda
> recibir planillas**. Este doc analiza si conviene y qué costaría.
> Solo análisis — no implementado.

---

## 1. Qué puede hacer un ADMIN HOY en el circuito de cobranza (verificado en código)

| Acción | ¿ADMIN puede? | Evidencia |
|---|---|---|
| Crear operaciones (pre-venta/préstamo) | ✅ | `credits.routes:35` autoriza ADMIN |
| Registrar pre-cargas de cobro | ✅ | `payments.routes:33` autoriza ADMIN |
| Registrar gestiones / programar visitas | ✅ | `collectionAttempts.routes` autoriza ADMIN |
| Ver todas las planillas y su detalle | ✅ | scoping de `collections.service:194-206` (solo restringe a cobradores) |
| **Ser destino de una planilla** | ❌ | `collections.service:47` valida rol `COLLECTOR/SELLER_COLLECTOR` |
| **Tener clientes asignados (cobrador del cliente)** | ❌ | `customers.queries.findCollectorById:209` valida rol |
| **Usar la vista de trabajo de planilla** (registrar cobros cuota a cuota) | ❌ | módulo front `/collector` gateado a `COLLECTOR/SELLER_COLLECTOR` (`app.routes.ts:50`); el detalle admin (`admin-collection-detail`) es **solo lectura** |

**Conclusión estructural:** el ADMIN ya participa de casi todo el circuito. Los
bloqueos son **3 validaciones puntuales de backend + el acceso al módulo
collector del front**. No hay nada en la BD que lo impida
(`customers.assigned_collector_id` es FK a `users` sin restricción de rol).

---

## 2. Hallazgo lateral (existe HOY, con o sin este cambio)

**Inconsistencia latente de comisiones:** al aprobar una SALE, la comisión se
genera para `credit.created_by` **sin mirar el rol** (`credits.service:996`).
Pero la liquidación semanal solo lista roles `SELLER/COLLECTOR/SELLER_COLLECTOR`
(`commissions.queries:170`). → **Si un ADMIN crea una venta hoy (ya puede),
se genera una comisión que jamás aparece en ninguna liquidación.** Comisión
fantasma. Este análisis lo expone; la decisión de negocio es del §5.

---

## 3. Comparación de opciones

### Opción A — Permitir ADMIN como destinatario de planillas (propuesta Dante)

**Una cuenta por persona.** Samuel administra Y cobra con su ADMIN.

| ✔ Pros | ✘ Contras |
|---|---|
| Un solo login por humano (los dueños cobran **todos los días**: el doble login es fricción permanente, en el celular, en la calle) | Todos los ADMIN aparecen como cobradores asignables (incluye la cuenta genérica "Administrador del sistema" — ruido en dropdowns) |
| La migración asigna los 94 clientes de la zona SAMUEL directo a su ADMIN real (<DNI-ADMIN-SAMUEL>) — sin cuenta duplicada ni DNI sintético para él | Diluye levemente la semántica de roles ("cobrador" deja de ser un rol y pasa a ser "usuario con clientes asignados") |
| Elimina la clase de errores "¿en qué cuenta estoy?" (aprobar con la operativa, cobrar con la admin…) | Toca ~6 puntos de código (bajo, ver §4, pero no cero) |
| Obliga a resolver bien las guardas de `users` (hoy un ADMIN con clientes asignados podría desactivarse dejando clientes huérfanos — bug latente si algún día se asignara) | El doble control pre-carga→aprobación queda en la misma cuenta para los dueños (hoy ya queda en la misma **persona** con 2 cuentas: control real idéntico) |

### Opción B — Cuenta doble (lo planificado hasta ahora)

| ✔ Pros | ✘ Contras |
|---|---|
| **Cero código** — funciona hoy | 2 logins por dueño, para siempre; cambio de cuenta varias veces al día |
| Modelo de roles intacto | Las ventas de la cuenta operativa generan comisiones que los dueños se "liquidan a sí mismos" (ruido contable semanal permanente) |
| | En listados/reportes aparecen 2 "Samuel" distintos (confusión de equipo) |
| | La comisión fantasma del §2 sigue existiendo igual (si el dueño vende como ADMIN por error de cuenta) |

### Opción C — Sistema multi-rol (un usuario, N roles)

Rediseño del modelo de auth (columna `role` → tabla de roles, middleware,
JWT, front). **Descartada: impacto alto**, desproporcionado para 2 personas.

---

## 4. Mapa de impacto de la Opción A (cambio por cambio)

### Backend — 4 ediciones chicas + tests

| Archivo:línea | Cambio |
|---|---|
| `collections.service.js:47` | Incluir `'ADMIN'` en la validación del destinatario de la planilla |
| `customers.queries.js:209` (`findCollectorById`) | Incluir `'ADMIN'` (usado por alta y edición de cliente al asignar cobrador) |
| `users.service.js:65` (cambio de rol) | La guarda "tiene clientes asignados" debe aplicar a **cualquier** usuario con clientes (hoy solo mira roles cobrador) — corrige además el bug latente |
| `users.service.js:110` (desactivación) | Ídem guarda por clientes asignados |

Sin migración de BD. Sin cambios en planilla/mora/saldos (frecuencia-agnósticos
del rol: trabajan por `assigned_collector_id`).

### Frontend — 3 ediciones

| Archivo | Cambio |
|---|---|
| `admin/users/users.service.ts:107` (`listCollectors`) | `roles: 'COLLECTOR,SELLER_COLLECTOR,ADMIN'` → los ADMIN aparecen en: diálogo de generar planilla y selector de cobrador del cliente (única fuente, se propaga solo) |
| `app.routes.ts:50` (módulo `/collector`) | Agregar `Roles.ADMIN` → el admin accede a "Mi ruta" y a la vista de trabajo de SU planilla |
| `nav-config.ts` | Mostrar la entrada "Mi ruta" (sección cobrador) también para ADMIN |

**Detalle a cuidar (el único no trivial):** `collector-payments` (y el listado
de "mis planillas") se apoyan en el scoping por rol del backend (cobrador → ve
lo suyo; ADMIN → ve TODO). Si un ADMIN entra a "Mi ruta", esas vistas deben
pedir **sus** datos explícitamente (`collector_id = mi id` — el filtro ya
existe en la API de payments) en vez de heredar el scoping. Son 1-2 llamadas a
ajustar en el front.

### Comisiones — 1 decisión + 1 edición (cierra el §2)

Elegir una:
- **(a) Los dueños NO comisionan** (recomendada): en la aprobación de SALE,
  no generar comisión si el creador es ADMIN (`credits.service:996` y la rama
  de venta de contado `:1212`). Regla limpia: "las comisiones son para
  empleados".
- (b) Los dueños SÍ comisionan: incluir `'ADMIN'` en
  `commissions.queries:170` para que sus comisiones aparezcan en liquidación.

### Migración (carga inicial) — 1 ajuste

- `extract.py`/`migrate.load.js`: mapear la zona `SAMUEL` al ADMIN existente
  (DNI <DNI-ADMIN-SAMUEL>) en lugar de crear el usuario operativo "Samuel". Config de
  mapeo explícita (`{"SAMUEL": "<DNI-ADMIN-SAMUEL>"}`). Bichy/Gaston/Alejo sin cambios.

### Estimación total

**~1 jornada** con tests (backend 4 líneas + tests de collections/customers/
users; front 3 ediciones + ajuste de scoping + specs). Riesgo bajo: todos los
cambios son ampliar listas de roles en validaciones puntuales; ninguna query de
dinero/fechas se toca.

---

## 5. Decisiones para cerrar antes de implementar

1. **¿Opción A confirmada?** (recomendación: sí — ver §6).
2. **Comisiones de dueños**: ¿(a) no comisionan o (b) comisionan y se liquidan?
   Recomendación: **(a)**.
3. **Cuenta genérica** "Administrador del sistema" (00000000): va a aparecer
   como cobrador asignable. ¿Se acepta el ruido o se desactiva esa cuenta y
   cada admin usa la suya personal? Recomendación: **desactivarla** (mejor
   auditoría: cada acción con nombre y apellido) — decisión del negocio.
4. **Timing vs. carga del jueves** (§7).

---

## 6. Recomendación

**Implementar la Opción A.** Fundamento:

- El costo es genuinamente bajo (~1 jornada, cambios de "ampliar rol permitido"
  sin tocar lógica de dinero ni fechas).
- El beneficio es permanente: los dueños cobran **a diario** — la cuenta doble
  es fricción de todos los días para siempre, y una fuente conocida de errores
  de operación ("aprobé con una cuenta, cobré con la otra").
- El doble control no se debilita en la práctica: con cuenta doble el mismo
  humano ya hace pre-carga y aprobación; solo cambia que queda bajo una cuenta.
- De paso corrige dos bugs latentes que existen HOY: la comisión fantasma de
  ventas creadas por ADMIN (§2) y la guarda de desactivación que no contempla
  usuarios no-cobradores con clientes asignados.

## 7. Timing respecto de la carga del jueves

Dos caminos válidos:

- **Camino 1 — A antes de la carga** (ideal si llega): implementar + testear +
  desplegar Opción A antes del jueves. La carga asigna la zona SAMUEL al ADMIN
  real. Nace limpio.
- **Camino 2 — cargar como está y migrar después**: el jueves se carga con la
  cuenta operativa "Samuel" (plan actual). Cuando la Opción A esté en
  producción, la transición es **un UPDATE** (`assigned_collector_id` de los
  clientes de la operativa → al ADMIN de Samuel) + desactivar la cuenta
  operativa. 5 minutos, sin riesgo.

**No hay lock-in**: elegir el camino 2 no compromete nada. La decisión de
implementar A puede tomarse con calma y aplicarse después del go-live.
