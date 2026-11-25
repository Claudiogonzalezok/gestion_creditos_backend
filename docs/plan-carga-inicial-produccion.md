# Plan de carga inicial en producción — Migración desde planilla Excel

> Origen: `COBRANZA ARTICULO 07-07-2026.xlsx` (planilla operativa del cliente).
> Objetivo: cargar clientes, usuarios, productos, tasas y créditos vigentes para
> que el negocio empiece a operar con el sistema. Documento para el equipo:
> análisis del origen, mapeo, decisiones, arquitectura del script y runbook.

---

## 1. Qué contiene el Excel (inventario verificado)

| Hoja | Contenido | Uso en la carga |
|---|---|---|
| `Planilla COBRANZA` | **Maestro de créditos vigentes**: 880 filas de datos = 879 créditos reales + 1 encabezado de sección (`MENSUALES`, fila 448) | **Fuente principal** |
| `CONTROL DE PAGOS` | 881 fichas por crédito (datos personales + historial de pagos: **5.249 pagos** con monto y fecha) | Fechas de inicio (F.ENTREGA/F.INICIO, 870 cargadas) y validación cruzada |
| `Hoja1` | **Catálogo de artículos**: 25 productos con costo, stock (CANTIDAD), precio Tadeo, precio Leandro y PRECIO FINAL | Alta de productos + stock |
| `Venta semanal` / `gastos semanales` | Plantillas vacías | No se cargan |

### Estructura del maestro (`Planilla COBRANZA`)

- **Columnas:** Nombre | Zona/Cobrador | Producto | CTAS (cuotas) | IMP (valor cuota) | C.PGA | PAGADO | SALDO | PLAN | grilla semanal de cobro (vacía en este snapshot).
- **Secciones por fila:**
  - **Filas 3–447 → créditos SEMANALES** (445): `PLAN` = día de la semana en que paga (lunes 77, martes 35, miércoles 36, jueves 22, viernes 61, **sábado 210**). Incluye **1 crédito DIARIO** (`DIARO`, 60 cuotas) y 3 filas con `PLAN=#REF!` (fórmula rota, a confirmar día).
  - **Fila 448 → encabezado "MENSUALES"** (no es un crédito).
  - **Filas 449–883 → créditos MENSUALES** (434): `PLAN` = **fecha del próximo vencimiento** (las fechas pasadas = crédito en mora).
- **Zonas/cobradores** (col "DIRECCION", que NO es dirección): BICHY 451 · GASTON 175 · ALEJO 158 · SAMUEL 94.
- **Tipos:** 247 PRÉSTAMOS + 632 VENTAS (218 nombres de producto distintos en ventas históricas).

### Calidad de datos (verificada)

- ✅ **878/880 filas cierran exacto**: `CTAS × IMP = PAGADO + SALDO`. El modelo de cuota uniforme del sistema calza perfecto con el negocio.
- Las 2 excepciones: una fila con la celda CTAS en formato fecha (artefacto de Excel — detalle en `anomalias.csv`) y el encabezado `MENSUALES`.
- 2 créditos con `SALDO = 0` (ya saldados) · 138 con `PAGADO = 0` (sin pagos aún).
- **DNI: 0 cargados** en las 881 fichas → se sintetizan todos (ver §4).
- Teléfono: solo 2. Dirección real: 0. Vendedor en ficha: 0.

---

## 2. Exclusiones — operaciones en dólares (confirmado por el cliente)

**No se cargan.** Detectadas **14** (todas préstamos de 1 cuota):

- 5 etiquetadas `PRESTAMO USD` (montos $75–$650).
- **9 sin etiquetar pero con montos imposibles en pesos** (cuota < $5.000, montos $90–$810).

> Nombres, filas y montos exactos: en `excluidos_usd.csv` (canal privado —
> este documento no incluye datos de clientes a propósito).

→ El script excluye por regla: `PRODUCTO contiene 'USD'` **o** `IMP < $5.000`. La lista exacta va en un CSV de revisión para que el cliente confirme antes de la carga.

**Resultado: ~865 créditos a cargar** (879 − 14 USD, ±los 2 saldados según decisión §6.5).

---

## 3. Mapeo Excel → sistema (entidad por entidad)

### 3.1 Usuarios (`users`)

**Producción ya tiene 3 ADMIN** (no se tocan): Administrador del sistema
(00000000), Tadeo Heredia (<DNI-ADMIN-TADEO>) y Samuel Ruiz (<DNI-ADMIN-SAMUEL>).

La carga crea **un usuario operativo por zona de cobranza real del Excel**
(derivado de los créditos, no de una lista fija):

| Persona | Evidencia en planilla | Rol (DEFINIDO) |
|---|---|---|
| BICHY, GASTON, ALEJO | Zonas de cobranza | `SELLER_COLLECTOR` (rol mixto) |
| SAMUEL (**Samuel Machuca** — cobrador empleado, **NO es Samuel Ruiz el socio**; confirmado por Tadeo 2026-07-14) | Zona de cobranza (94 créditos) | `SELLER_COLLECTOR` (rol mixto), igual que los otros 3 |
| TADEO | Solo lista de precios en el catálogo — **NO es zona de cobranza** | No se crea (su cuenta ADMIN de producción alcanza) |
| LEANDRO | Solo lista de precios — no incide en ninguna planilla | ✅ **RESUELTO: no se crea** (decisión 2026-07-14). Si lo necesitan, lo registran ellos desde la UI de Usuarios |

> **Aclaración importante (2026-07-14):** el "SAMUEL" de las planillas es
> **Samuel Machuca**, un cobrador empleado — no Samuel Ruiz (socio/ADMIN),
> como se asumió inicialmente. Por lo tanto **no existe conflicto de cuenta
> doble**: los 4 usuarios de zona son empleados comunes con una sola cuenta.
> El análisis de "planillas para ADMIN" (`docs/analisis-planilla-para-admin.md`)
> queda archivado como referencia por si algún día un socio sale a cobrar,
> sin urgencia.
>
> El loader detecta y reporta el ADMIN existente de producción (lo usa como
> `approved_by` de los créditos migrados) y ADVIERTE si no encuentra ninguno.
>
> Nota operativa: los usuarios se crean con el nombre de la zona ("Samuel",
> "Bichy"…). El Admin puede completar nombre y apellido reales desde la UI
> de Usuarios después de la carga (ej. "Samuel Machuca").

- DNI numérico sintético (ver §4), contraseña temporal `Cambiar.2026` con
  `is_temp_password = TRUE` (el sistema fuerza el cambio al primer login),
  teléfono si lo aportan.

### 3.2 Clientes (`customers`)

- 1 fila del maestro = 1 crédito; clientes repetidos: **45 nombres con 2–3 créditos** (93 filas). Dedupe por nombre normalizado (mayúsculas/minúsculas + sufijos numéricos: `belen quiroga 1` / `belen quiroga 2` = misma persona con 2 créditos).
- **≈ 830 clientes únicos** estimados. El extractor genera `clientes_revision.csv` con la deduplicación propuesta para validar ANTES de cargar (riesgo: dos personas distintas con el mismo nombre).
- Campos: nombre completo (normalizado a Título), **DNI sintético**, dirección/teléfono vacíos (no existen en origen; se completan después con la edición de clientes), `collector` = usuario de la zona (BICHY/GASTON/ALEJO/SAMUEL).
- Nombres "comerciales" (negocios, apodos) se cargan igual como clientes.

### 3.3 Productos (`products` + `product_units`) — catálogo Hoja1

- 25 artículos con: costo (`PRECIO/U`), **stock real** (`CANTIDAD` → N unidades `AVAILABLE`), y precio de venta (`PRECIO FINAL`).
- **Decisión pendiente §6.7:** qué precio de lista usar (FINAL = lista Leandro; existe lista Tadeo más baja — ¿dos canales?).
- Los **218 nombres de producto de ventas históricas NO generan productos** en el catálogo (sería basura sin stock ni precio). El producto vendido queda registrado en las notas del crédito histórico (ver 3.5).

### 3.4 Tasas (`interest_rates` + `product_rates`)

Necesarias para que las **operaciones nuevas** funcionen desde el día 1 (sin tasa → la aprobación da 422). Las combinaciones reales del negocio, derivadas de la planilla:

- **Semanal:** 4, 8, 12, 15, 16, 20, 24, 30, 34 cuotas.
- **Mensual:** 1, 2, 3, 4, 5, 6, 8, 9, 12, 24 cuotas.
- **Diaria:** 60 cuotas (y las que definan).
- Markup observable en catálogo: costo → precio final ≈ +30% a +56%.

→ **RESUELTO (2026-07-15, decisión del cliente):** el equipo carga tasas
iniciales con `src/scripts/migracion/seed.tasas.js` y el cliente **las edita
después desde la UI** de Configuración. El seed:
- Cubre **las 4 frecuencias** (diaria, semanal, quincenal, mensual) para
  préstamos (banda única de monto 0→sin tope) y para los 24 productos del
  catálogo (14 combos por producto).
- Valores anclados a la curva histórica del negocio (~30% por mes de plazo,
  sublineal a plazos largos — misma curva del seed semanal ya existente).
- **Respeta lo existente:** producción ya tiene tasas semanales/quincenales
  por banda de monto (migración 005) — el seed saltea cualquier combo que ya
  tenga tasa (evita bandas solapadas, lección de la migración 010) y es
  idempotente.

**Los créditos migrados NO dependen de estas tasas** (se insertan con sus
valores históricos congelados).

### 3.5 Créditos + cuotas (`credits` + `installments`) — estrategia "saldo inicial"

**Se carga el estado actual, NO los 5.249 pagos históricos.** Justificación:
- `PAGADO`/`SALDO` cierran exacto contra `CTAS × IMP` en 878/880 filas → el estado es confiable sin reconstruir la historia.
- Cargar pagos históricos por el flujo normal contaminaría **caja** (todo cobro aprobado se imputa a la caja activa) y **jornadas** retroactivas. Inaceptable en producción.
- La historia queda preservada en el Excel (archivo) y resumida en las notas del crédito: `"Migración 07-2026 — pagado histórico: $X en N pagos"`.

**Inserción DIRECTA a BD (script, no API)** para evitar los efectos del flujo de aprobación que NO deben ocurrir en una migración:

| Efecto del flujo normal | En la migración |
|---|---|
| Busca tasa y recalcula cuota | ❌ Se insertan `IMP`/totales históricos tal cual |
| Genera comisión (SALE) | ❌ Sin comisiones retroactivas |
| Descuenta stock | ❌ Las ventas históricas ya se entregaron |
| Egreso de caja (LOAN) | ❌ El dinero salió hace meses |
| Cronograma desde hoy | ❌ Fechas según PLAN real |

**Por crédito:**
- `type`: LOAN (`PRESTAMO`) o SALE (nombre de producto). SALE histórica **sin** `credit_products` (producto en notas — validar en staging que el detalle UI lo tolere; alternativa: todos como LOAN con nota "VENTA: <producto>").
- `status = 'ACTIVE'`, `payment_frequency`: `WEEKLY` / `MONTHLY` / `DAILY`.
- Cuotas: `total = CTAS`, pagadas = `floor(PAGADO / IMP)` → `PAID` con nota "Migración"; si hay resto → 1 cuota `PARTIAL`; las restantes `PENDING` con `original_amount = IMP`.
- **Sin registros en `payments`** (no hubo cobro por el sistema) — las cuotas PAID de migración llevan nota y no tocan caja.
- **Fechas de vencimiento:**
  - **MENSUALES:** próxima cuota = fecha de `PLAN` (aunque sea pasada → **la mora real queda visible**); siguientes +1 mes calendario.
  - **SEMANALES:** próxima cuota = próxima ocurrencia del día de `PLAN` desde la fecha de carga; siguientes +7 días. (No se puede reconstruir mora semanal por cuota: la deuda total es correcta y el cronograma arranca "al día" — ver decisión §6.6.)
  - **DIARIO:** próxima cuota = día siguiente a la carga; siguientes +1 día.
- **Mora retroactiva: NO.** Todas las cuotas migradas se insertan con `last_penalty_applied_at = fecha de carga` para que el cron de mora **no aplique punitorios por el pasado** (solo desde el go-live en adelante). Sin esto, el cron castigaría el día 1 a todos los mensuales vencidos.
- Marca de auditoría: nota `[MIGRACION 2026-07]` en cada crédito → permite identificar, verificar y (si hiciera falta) revertir la carga completa.

### 3.6 Lo que NO se toca

Jornadas, cajas, tesorería, comisiones, planillas, gastos: **nada**. El negocio arranca de cero en caja el primer día operativo.

---

## 4. DNI sintéticos (clientes y usuarios) — definido con el cliente

- Solo números (los validators exigen 7–9 dígitos).
- **Secuencia propuesta: desde `99.000.001`** (fuera del rango de DNIs argentinos reales, incluidos los de extranjeros ~92–95M) → nunca colisiona con un DNI verdadero cargado a futuro.
- Únicos (los exige la BD y el login del portal de clientes usa DNI).
- El mapeo `cliente → DNI asignado` sale en `dni_asignados.csv` para entregarle al cliente.
- Cuando consigan el DNI real de cada cliente, se corrige con la función existente **editar DNI (solo Admin)** — ya en producción.

---

## 5. Arquitectura del script (2 etapas + revisión intermedia)

```
Excel (.xlsx)
   │  1. extract.py  (python + openpyxl — corre en cualquier máquina)
   ▼
migracion/                    ← carpeta en la raíz del repo backend, GITIGNORED
  ├─ datos.json              ← estado normalizado listo para cargar
  ├─ clientes_revision.csv   ← dedupe de clientes (revisa el CLIENTE)
  ├─ excluidos_usd.csv       ← los 14 USD (confirma el CLIENTE)
  ├─ anomalias.csv           ← #REF!, PLAN vacío, CTAS-fecha, saldos 0
  └─ dni_asignados.csv       ← mapeo DNI sintético
   │  2. migrate.load.js  (node + pg — corre en el servidor de prod)
   ▼
PostgreSQL producción
```

**Ubicación del código y de los datos:**
- Scripts (versionados): `src/scripts/migracion/extract.py` y
  `src/scripts/migracion/migrate.load.js` — en la rama `feat/carga-inicial-produccion`.
- **Datos generados: `migracion/` en la raíz del repo, EXCLUIDA por `.gitignore`.**
  Contiene datos personales de clientes del negocio: **jamás se commitea ni se
  sube a GitHub**. Se comparte con el cliente/equipo por canal privado.

**`extract.py`** — lee el Excel, aplica reglas (secciones, USD, dedupe, DNIs), cruza fichas de CONTROL DE PAGOS (F.INICIO), y emite JSON + CSVs de revisión. **No toca ninguna BD.**

**`migrate.load.js`** — mismo patrón que los seeds del repo:
- **`--dry-run`** (default): valida todo y muestra el reporte SIN escribir.
- **Una sola transacción**: o entra todo o no entra nada.
- **Idempotente**: si detecta la marca `[MIGRACION 2026-07]` ya cargada, se niega a duplicar (re-ejecutar es seguro).
- Reporte final: conteos por entidad + suma de saldos vs Excel.

---

## 6. Decisiones que necesita confirmar el CLIENTE antes de cargar

| # | Pregunta | Propuesta por defecto |
|---|---|---|
| 1 | ~~Roles de los usuarios~~ | ✅ **RESUELTO: todos `SELLER_COLLECTOR`** |
| 2 | ~~¿TADEO y LEANDRO son usuarios?~~ | ✅ **RESUELTO: sí, `SELLER_COLLECTOR`** |
| 3 | ~~3 créditos con `PLAN=#REF!`~~ | ✅ **RESUELTO (Tadeo, 2026-07-15): quedan SIN cargar — alta manual** desde el sistema después del go-live |
| 4 | Confirmar los **14 USD excluidos** (`excluidos_usd.csv`) | Excluir |
| 5 | 2 créditos con SALDO=0: ¿cargar como SETTLED o no cargar? | No cargar (solo historial) |
| 6 | Mensuales vencidos entran **en mora visible** desde el día 1 (sin punitorios retroactivos). Semanales entran "al día". ¿OK? | Sí |
| 7 | Precio de lista de los 25 artículos: ¿FINAL (lista Leandro) o hay 2 canales? | PRECIO FINAL |
| 8 | ~~Tabla de tasas para operaciones nuevas~~ | ✅ **RESUELTO: seed inicial del equipo (`seed.tasas.js`), el cliente edita desde la UI** |
| 9 | Revisión del dedupe de clientes (`clientes_revision.csv`) | — |
| 10 | ¿Cargar teléfono/dirección después, a medida que cobren? | Sí (edición de cliente) |

---

## 7. Dependencia de despliegue — ⚠️ ANTES de la carga

1. **Mergear y desplegar `feat/frecuencia-daily`** (backend + frontend): hay 1 crédito diario en el origen y el negocio opera con diarias. Sin esto, ese crédito no se puede cargar y no se pueden configurar tasas diarias.
2. Verificar que la migración `045_payment_frequency_daily.sql` corrió en producción (`npm run migration:run`).

---

## 8. Runbook para el equipo (día de la carga)

1. **Freeze**: el cliente deja de anotar en el Excel y entrega la **versión final** (este análisis usa el snapshot 07-07; los números cambiarán → el extractor se re-corre tal cual).
2. Correr `extract.py` sobre la versión final → entregar los 4 CSVs de revisión al cliente → **OK escrito** de las decisiones §6.
3. **Backup completo de la BD de producción** (`pg_dump`). Sin backup no se carga.
4. Ensayo en staging/local: restaurar el backup, correr `migrate.load.js` (real), pasar el checklist §9. Ajustar si algo falla.
   - **Validación específica en staging:** abrir el **detalle de un crédito SALE
     histórico** (que se carga sin `credit_products`) y verificar que la UI no
     rompe (productos vacíos, montos y cronograma correctos). Si rompe →
     cambiar la estrategia a "todo como LOAN con nota `VENTA: <producto>`"
     ANTES de tocar producción.
     *Pre-validado a nivel backend (BD de test, 2026-07-10): `getById` y
     `getAll` del service real responden sin errores sobre un SALE migrado.
     Falta solo la verificación visual en el navegador.*
5. **Detener el backend de producción** (`pm2 stop` o equivalente). Los cron
   jobs (mora, vencimientos, comisiones, recordatorios) corren **dentro del
   proceso de la app**: detenerla los deshabilita todos de una y además
   garantiza que nadie opere el sistema a mitad de la carga.
6. En producción: `migrate.load.js --dry-run` → revisar reporte → correr real.
7. **Tasas iniciales**: `node src/scripts/migracion/seed.tasas.js` (dry-run) →
   `--ejecutar`. Corre DESPUÉS del loader (necesita los 24 productos creados).
8. Checklist §9 en producción (con el backend aún detenido, vía SQL).
9. **Re-levantar el backend** (`pm2 start`). Los crons vuelven a correr solos;
   verificar en el log de arranque que los 6 jobs inicien, y que el cron de
   mora NO aplique punitorios retroactivos (protegido por
   `last_penalty_applied_at`, §3.5).
10. Alta operativa: usuarios cambian contraseña, Admin abre jornada + caja, y el negocio opera.
11. **Rollback si algo salió mal**: detener backend → restaurar backup → re-levantar (la carga es una transacción sobre una BD sin datos operativos previos, la ventana de riesgo es mínima).

---

## 9. Checklist de verificación post-carga

- [ ] Conteos: créditos cargados = esperado del reporte (≈865) · clientes ≈830 · usuarios · 25 productos con sus unidades.
- [ ] `SUM(saldo pendiente)` del sistema == `SUM(SALDO)` del Excel (excluidos USD) — **el número más importante**.
- [ ] Totales por cobrador (BICHY/GASTON/ALEJO/SAMUEL) == totales por zona del Excel.
- [ ] Muestreo: 10 créditos elegidos por el cliente comparados ficha vs sistema (cuotas pagadas, saldo, próximo vencimiento).
- [ ] Mensuales vencidos aparecen en mora; NINGÚN punitorio retroactivo aplicado.
- [ ] Detalle de un crédito SALE histórico (sin `credit_products`) abre sin errores (validado antes en staging, re-chequear en prod).
- [ ] El crédito diario existe con cronograma día a día.
- [ ] Generar una planilla de cobranza de prueba por cobrador → aparecen las cuotas del día correcto.
- [ ] Login del portal con un DNI sintético.
- [ ] Simular (sin aprobar) una venta y un préstamo nuevos → las tasas responden.
- [ ] El dashboard no muestra recaudación/caja fantasma (la migración no tocó caja).

---

## 10. Resumen ejecutivo

- **Origen confiable**: 878/880 filas cierran matemáticamente; el modelo de cuota uniforme del sistema calza con el negocio sin forzar nada.
- **Se cargan**: ~830 clientes (DNI sintético desde 99.000.001), 4–7 usuarios, 25 productos con stock, tasas (semanal/mensual/diaria — las provee el cliente), **~865 créditos vigentes** con estado real (pagado/saldo/mora mensual visible).
- **Se excluyen**: 14 operaciones USD (5 etiquetadas + 9 detectadas por monto).
- **No se genera**: pagos históricos, comisiones, movimientos de caja, stock descontado, punitorios retroactivos.
- **Herramienta**: `extract.py` (análisis y revisión, sin BD) + `migrate.load.js` (transaccional, idempotente, dry-run) + 4 CSVs de control para el cliente.
- **Bloqueantes**: merge+deploy de `feat/frecuencia-daily`; tabla de tasas del cliente; respuestas §6 (ítems 3 y 8 son duros).
