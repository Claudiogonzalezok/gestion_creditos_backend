/**
 * Genera `migracion/carga-inicial.sql`: la carga inicial completa como UN solo
 * archivo SQL plano, para el equipo que prefiere ejecutar `psql -f` en vez del
 * loader Node. Lee `migracion/datos.json` (generado por extract.py) y reusa el
 * cronograma del loader (única fuente de fechas).
 *
 *   node src/scripts/migracion/generate.sql.js [--fecha YYYY-MM-DD]
 *
 * --fecha = DÍA EN QUE SE VA A CORRER el SQL en producción (default: hoy).
 *   ⚠ Las fechas del cronograma quedan HORNEADAS respecto de ese día (próximo
 *   día de pago semanal, mañana para el diario). Si la carga se posterga,
 *   REGENERAR el archivo con la fecha nueva.
 *
 * El SQL conserva las garantías del loader:
 *   - Una sola transacción (BEGIN/COMMIT).
 *   - Guarda anti-doble-carga (aborta si la marca ya existe).
 *   - approved_by = el ADMIN real de producción (resuelto al ejecutar).
 *   - Verificación final: si el saldo cargado difiere del Excel → EXCEPTION
 *     → rollback de todo.
 *   - Tasas: saltea combos de préstamo ya existentes y ON CONFLICT en las de
 *     producto (no duplica lo que producción ya tiene por la migración 005).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { cronograma, iso, PASSWORD_TEMPORAL } = require("./migrate.load");

const DATOS = path.join(__dirname, "../../../migracion/datos.json");
const SALIDA = path.join(__dirname, "../../../migracion/carga-inicial.sql");
const MARCA = "[MIGRACION 2026-07]";

// Misma curva que seed.tasas.js (valores iniciales editables desde la UI).
const CURVA = {
  DAILY: { 30: 0.3, 60: 0.55 },
  WEEKLY: { 4: 0.3, 8: 0.55, 12: 0.9, 16: 1.05, 20: 1.25, 24: 1.45, 30: 1.7 },
  BIWEEKLY: { 2: 0.3, 4: 0.55, 6: 0.9, 8: 1.05 },
  MONTHLY: { 1: 0.3, 2: 0.55, 3: 0.9, 4: 1.05, 6: 1.45, 9: 1.9, 12: 2.3 },
};
const COMBOS_VENTA = {
  DAILY: [30, 60],
  WEEKLY: [8, 12, 16, 20, 24, 30],
  BIWEEKLY: [4, 8],
  MONTHLY: [3, 6, 9, 12],
};

/** Escapa string para literal SQL ('' por '). */
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const uuid = () => crypto.randomUUID();

/** Parte un array en tandas para INSERTs multi-fila razonables. */
const tandas = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const main = async () => {
  const argFecha = process.argv.indexOf("--fecha");
  const fechaCarga =
    argFecha !== -1 && process.argv[argFecha + 1]
      ? new Date(`${process.argv[argFecha + 1]}T12:00:00`)
      : new Date();
  if (isNaN(fechaCarga.getTime())) {
    console.error("--fecha inválida (usar YYYY-MM-DD)");
    process.exit(1);
  }

  const datos = JSON.parse(fs.readFileSync(DATOS, "utf8"));
  const t = datos.meta.totales;
  const hash = await bcrypt.hash(PASSWORD_TEMPORAL, 10);

  const sql = [];
  sql.push(`-- ============================================================================
-- CARGA INICIAL EN PRODUCCIÓN — Migración desde planilla del cliente
-- Origen   : ${datos.meta.origen}
-- Generado : ${new Date().toISOString()}  (generate.sql.js)
-- FECHA DE CARGA OBJETIVO: ${iso(fechaCarga)}
--   ⚠ Los vencimientos están calculados respecto de esa fecha. Si la carga se
--     posterga, REGENERAR este archivo (node src/scripts/migracion/generate.sql.js
--     --fecha YYYY-MM-DD). NO ejecutar en otra fecha.
-- Esperado : ${t.creditos} créditos · saldo total $${t.suma_saldo} (verificado al final;
--            si difiere, la transacción entera se revierte sola).
-- Requisitos: migraciones al día (npm run migration:run) y backend DETENIDO.
-- Ejecutar : psql -U <user> -d <db> -f carga-inicial.sql   (o pgAdmin, 1 sola vez)
-- ============================================================================

BEGIN;

-- ── Guarda anti-doble-carga ─────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*) INTO n FROM credits WHERE notes LIKE '%${MARCA}%';
  IF n > 0 THEN
    RAISE EXCEPTION 'La migración ya fue cargada (% créditos con la marca ${MARCA}). Abortando.', n;
  END IF;
END $$;

-- ── ADMIN real de producción (approved_by de los créditos migrados) ────────
CREATE TEMP TABLE _mig_admin ON COMMIT DROP AS
  SELECT id FROM users
  WHERE role = 'ADMIN' AND status = 'ACTIVE'
  ORDER BY created_at LIMIT 1;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM _mig_admin) = 0 THEN
    RAISE EXCEPTION 'No hay usuario ADMIN activo en esta base. Crear el admin ANTES de cargar.';
  END IF;
END $$;
`);

  // ── 1. Usuarios operativos ────────────────────────────────────────────────
  const userIdPorZona = {};
  const userRows = datos.usuarios.map((u) => {
    const id = uuid();
    userIdPorZona[u.nombre.toUpperCase()] = id;
    return `('${id}', ${q(u.nombre)}, ${q(u.dni)}, ${q(hash)}, ${q(u.rol)})`;
  });
  sql.push(`-- ── 1. Usuarios operativos (${userRows.length}) — password temporal: ${PASSWORD_TEMPORAL} ──
INSERT INTO users (id, full_name, dni, password_hash, role) VALUES
${userRows.join(",\n")};
`);

  // ── 2. Clientes ───────────────────────────────────────────────────────────
  const customerIdPorDni = {};
  const custRows = datos.clientes.map((c) => {
    const id = uuid();
    customerIdPorDni[c.dni] = id;
    const collector = userIdPorZona[c.zona] ? `'${userIdPorZona[c.zona]}'` : "NULL";
    return `('${id}', ${q(c.nombre)}, ${q(c.dni)}, ${collector})`;
  });
  sql.push(`-- ── 2. Clientes (${custRows.length}) ──`);
  for (const tanda of tandas(custRows, 200)) {
    sql.push(`INSERT INTO customers (id, full_name, dni, assigned_collector_id) VALUES
${tanda.join(",\n")};`);
  }

  // ── 3. Catálogo: producto + variante + unidades ───────────────────────────
  const productos = [];
  const prodRows = [];
  const varRows = [];
  const unitRows = [];
  datos.productos.forEach((p, idx) => {
    if (!p.precio_lista || p.precio_lista <= 0) return;
    const pid = uuid();
    const vid = uuid();
    productos.push({ id: pid, nombre: p.nombre });
    prodRows.push(
      `('${pid}', ${q(p.nombre)}, ${q(`Carga inicial ${MARCA}. Costo de referencia: $${p.costo ?? "-"}`)})`,
    );
    varRows.push(`('${vid}', '${pid}', ${p.precio_lista})`);
    for (let n = 1; n <= p.stock; n++) {
      unitRows.push(
        `('${vid}', ${q(`MIG-${String(idx + 1).padStart(2, "0")}-${String(n).padStart(3, "0")}`)}, ${q(MARCA)})`,
      );
    }
  });
  sql.push(`
-- ── 3. Catálogo (${prodRows.length} productos, ${unitRows.length} unidades) ──
INSERT INTO products (id, title, description) VALUES
${prodRows.join(",\n")};

INSERT INTO product_variants (id, product_id, current_price) VALUES
${varRows.join(",\n")};

INSERT INTO product_units (variant_id, unit_code, notes) VALUES
${unitRows.join(",\n")};
`);

  // ── 4. Créditos + cuotas ──────────────────────────────────────────────────
  const credRows = [];
  const instRows = [];
  for (const cr of datos.creditos) {
    const creditId = uuid();
    const customerId = customerIdPorDni[cr.cliente_dni];
    if (!customerId) throw new Error(`Fila ${cr.fila_excel}: cliente ${cr.cliente_dni} sin id`);
    const totalAmount = cr.ctas * cr.imp;
    const notas = [
      MARCA,
      cr.tipo === "SALE" ? `Producto: ${cr.producto}` : null,
      `Fila Excel ${cr.fila_excel} — zona ${cr.zona}.`,
      `Histórico pre-sistema: pagado $${cr.pagado.toLocaleString("es-AR")}` +
        (cr.pagos_historicos != null ? ` en ${cr.pagos_historicos} pagos` : "") + ".",
    ].filter(Boolean).join(" ");
    const fechaInicio = cr.f_inicio ? `${cr.f_inicio} 12:00:00` : `${iso(fechaCarga)} 12:00:00`;
    const createdBy = userIdPorZona[cr.zona] ? `'${userIdPorZona[cr.zona]}'` : "NULL";

    credRows.push(
      `('${creditId}', '${customerId}', ${createdBy}, (SELECT id FROM _mig_admin), ${q(cr.tipo)}, ${totalAmount}, ${cr.ctas}, ${q(cr.frecuencia)}, 'ACTIVE', ${q(notas)}, '${fechaInicio}', '${fechaInicio}')`,
    );

    const fechas = cronograma(cr, fechaCarga);
    for (let n = 1; n <= cr.ctas; n++) {
      const pagada = n <= cr.cuotas_pagadas;
      const parcial = !pagada && n === cr.cuotas_pagadas + 1 && cr.resto_parcial > 0;
      const amountPaid = pagada ? cr.imp : parcial ? cr.resto_parcial : 0;
      const status = pagada ? "PAID" : parcial ? "PARTIAL" : "PENDING";
      instRows.push(
        `('${creditId}', ${n}, '${fechas[n - 1]}', ${q(cr.frecuencia)}, ${cr.imp}, ${cr.imp}, ${amountPaid}, '${status}', NOW())`,
      );
    }
  }
  sql.push(`-- ── 4. Créditos (${credRows.length}) ──`);
  for (const tanda of tandas(credRows, 100)) {
    sql.push(`INSERT INTO credits (id, customer_id, created_by, approved_by, type, total_amount, installments_count, payment_frequency, status, notes, approved_at, created_at) VALUES
${tanda.join(",\n")};`);
  }
  sql.push(`-- ── 5. Cuotas (${instRows.length}) ──`);
  for (const tanda of tandas(instRows, 500)) {
    sql.push(`INSERT INTO installments (credit_id, installment_number, due_date, payment_frequency, original_amount, amount_due, amount_paid, status, last_penalty_applied_at) VALUES
${tanda.join(",\n")};`);
  }

  // ── 6. Tasas de préstamo (saltea combos existentes) ───────────────────────
  sql.push(`\n-- ── 6. Tasas de préstamo (banda única 0→sin tope; saltea combos ya cargados) ──`);
  for (const [freq, cuotasMap] of Object.entries(CURVA)) {
    for (const [cuotas, tasa] of Object.entries(cuotasMap)) {
      sql.push(
        `INSERT INTO interest_rates (payment_frequency, installments_count, min_amount, max_amount, rate, active)
SELECT ${q(freq)}, ${cuotas}, 0, NULL, ${tasa}, TRUE
WHERE NOT EXISTS (SELECT 1 FROM interest_rates WHERE payment_frequency = ${q(freq)} AND installments_count = ${cuotas} AND active = TRUE);`,
      );
    }
  }

  // ── 7. Tasas por producto ─────────────────────────────────────────────────
  const rateRows = [];
  for (const p of productos) {
    for (const [freq, lista] of Object.entries(COMBOS_VENTA)) {
      for (const cuotas of lista) {
        rateRows.push(`('${p.id}', ${q(freq)}, ${cuotas}, ${CURVA[freq][cuotas]}, TRUE)`);
      }
    }
  }
  sql.push(`\n-- ── 7. Tasas por producto (${rateRows.length}) ──`);
  for (const tanda of tandas(rateRows, 300)) {
    sql.push(`INSERT INTO product_rates (product_id, payment_frequency, installments_count, rate, active) VALUES
${tanda.join(",\n")}
ON CONFLICT (product_id, payment_frequency, installments_count) DO NOTHING;`);
  }

  // ── 8. Verificación final ─────────────────────────────────────────────────
  sql.push(`
-- ── 8. VERIFICACIÓN (si falla, TODO se revierte) ──
DO $$
DECLARE c int; s numeric;
BEGIN
  SELECT COUNT(DISTINCT cr.id), COALESCE(SUM(i.amount_due - i.amount_paid), 0)
    INTO c, s
  FROM credits cr JOIN installments i ON i.credit_id = cr.id
  WHERE cr.notes LIKE '%${MARCA}%';
  IF c <> ${t.creditos} THEN
    RAISE EXCEPTION 'Créditos cargados (%) != esperados (${t.creditos}) — ROLLBACK', c;
  END IF;
  IF ABS(s - ${t.suma_saldo}) > 1 THEN
    RAISE EXCEPTION 'Saldo cargado (%) != Excel (${t.suma_saldo}) — ROLLBACK', s;
  END IF;
  RAISE NOTICE 'VERIFICACIÓN OK: % créditos, saldo $% == Excel', c, s;
END $$;

COMMIT;
`);

  fs.writeFileSync(SALIDA, sql.join("\n"), "utf8");
  const mb = (fs.statSync(SALIDA).size / 1024 / 1024).toFixed(1);
  console.log(`\n✅ ${SALIDA} (${mb} MB)`);
  console.log(`   Fecha de carga objetivo: ${iso(fechaCarga)} ← regenerar si cambia`);
  console.log(`   ${t.creditos} créditos · ${instRows.length} cuotas · ${custRows.length} clientes · ${userRows.length} usuarios`);
  console.log(`   ${prodRows.length} productos · tasas préstamo + ${rateRows.length} de producto`);
  console.log(`   Saldo esperado: $${t.suma_saldo.toLocaleString("es-AR")} (autoverificado al final)\n`);
};

main();
