/**
 * Etapa 2 de la carga inicial — Loader a PostgreSQL.
 *
 * Lee `migracion/datos.json` (generado por extract.py) e inserta usuarios,
 * clientes, productos (con variante + unidades) y créditos con sus cuotas,
 * en UNA sola transacción. Ver docs/plan-carga-inicial-produccion.md.
 *
 * Modo por defecto: DRY-RUN — ejecuta absolutamente todo dentro de la
 * transacción (incluidas las verificaciones) y hace ROLLBACK al final.
 * Con `--ejecutar` hace COMMIT.
 *
 *   node src/scripts/migracion/migrate.load.js              (dry-run)
 *   node src/scripts/migracion/migrate.load.js --ejecutar   (carga real)
 *
 * Garantías:
 *  - Idempotente: si detecta la marca de migración ya cargada, aborta.
 *  - Sin efectos colaterales: no toca caja, jornadas, comisiones, pagos ni
 *    stock de ventas históricas. Sin punitorios retroactivos
 *    (last_penalty_applied_at = NOW() en todas las cuotas migradas).
 *  - Verificación interna: si la suma de saldos cargados no coincide con el
 *    Excel, aborta con rollback.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const { addFrequencyPeriods } = require("../../utils/creditCalculator");

const DATOS = path.join(__dirname, "../../../migracion/datos.json");
const EJECUTAR = process.argv.includes("--ejecutar");
const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || "10");
const PASSWORD_TEMPORAL = "Cambiar.2026"; // is_temp_password=TRUE fuerza el cambio al primer login

// JS getDay(): 0=domingo ... 6=sábado
const DIA_SEMANA = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };

/** 'YYYY-MM-DD' local, sin sesgo UTC. */
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Próxima ocurrencia (estricta) del día de semana indicado. */
const proximoDia = (desde, diaNombre) => {
  const objetivo = DIA_SEMANA[diaNombre.normalize("NFD").replace(/[̀-ͯ]/g, "")];
  const d = new Date(desde);
  d.setHours(12, 0, 0, 0);
  do d.setDate(d.getDate() + 1);
  while (d.getDay() !== objetivo);
  return d;
};

/**
 * Cronograma completo del crédito migrado.
 * Ancla = vencimiento de la primera cuota NO saldada; las pagadas se fechan
 * hacia atrás y las pendientes hacia adelante con la misma frecuencia
 * (reutiliza addFrequencyPeriods: única fuente de verdad de fechas).
 */
const cronograma = (credito, hoy) => {
  let ancla;
  if (credito.frecuencia === "MONTHLY") {
    const [y, m, d] = credito.proximo_venc.split("-").map(Number);
    ancla = new Date(y, m - 1, d, 12);
  } else if (credito.frecuencia === "WEEKLY") {
    ancla = proximoDia(hoy, credito.dia_pago);
  } else {
    ancla = new Date(hoy);
    ancla.setHours(12, 0, 0, 0);
    ancla.setDate(ancla.getDate() + 1); // DAILY: mañana
  }
  const numAncla = credito.cuotas_pagadas + 1; // primera cuota no saldada
  const fechas = [];
  for (let n = 1; n <= credito.ctas; n++) {
    fechas.push(iso(addFrequencyPeriods(ancla, credito.frecuencia, n - numAncla)));
  }
  return fechas;
};

const main = async () => {
  if (!fs.existsSync(DATOS)) {
    console.error(`No existe ${DATOS} — correr antes extract.py`);
    process.exit(1);
  }
  const datos = JSON.parse(fs.readFileSync(DATOS, "utf8"));
  const marca = datos.meta.marca;
  const hoy = new Date();

  const pool = new Pool({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "gestion_creditos",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
  });

  const client = await pool.connect();
  console.log(`\n${EJECUTAR ? "🔥 CARGA REAL" : "🧪 DRY-RUN (rollback al final)"} → BD ${process.env.DB_NAME || "gestion_creditos"}@${process.env.DB_HOST || "localhost"}`);
  console.log(`   Origen: ${datos.meta.origen} (generado ${datos.meta.generado})\n`);

  try {
    await client.query("BEGIN");

    // ── Guardas de idempotencia ──────────────────────────────────────────
    const ya = await client.query(`SELECT COUNT(*)::int AS n FROM credits WHERE notes LIKE $1`, [`%${marca}%`]);
    if (ya.rows[0].n > 0) {
      throw new Error(`La marca ${marca} ya existe en ${ya.rows[0].n} créditos — migración ya cargada, abortando.`);
    }

    // approved_by: el ADMIN existente de producción (si hay).
    const adminRow = await client.query(
      `SELECT id, full_name FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
    );
    const adminId = adminRow.rows[0]?.id ?? null;
    if (adminId) {
      console.log(`   ADMIN existente: ${adminRow.rows[0].full_name} (será approved_by de los créditos migrados)\n`);
    } else {
      console.warn("   ⚠ NO hay ADMIN activo en esta BD: los créditos quedarían sin approved_by y nadie podría administrar. Crear el admin ANTES de cargar.\n");
    }

    // ── 1. Usuarios operativos ───────────────────────────────────────────
    const hashTemporal = await bcrypt.hash(PASSWORD_TEMPORAL, SALT_ROUNDS);
    const userIdPorZona = {};
    for (const u of datos.usuarios) {
      const r = await client.query(
        `INSERT INTO users (full_name, dni, password_hash, role)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [u.nombre, u.dni, hashTemporal, u.rol],
      );
      userIdPorZona[u.nombre.toUpperCase()] = r.rows[0].id;
    }

    // ── 2. Clientes ──────────────────────────────────────────────────────
    const customerIdPorDni = {};
    for (const c of datos.clientes) {
      const r = await client.query(
        `INSERT INTO customers (full_name, dni, assigned_collector_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [c.nombre, c.dni, userIdPorZona[c.zona] ?? null],
      );
      customerIdPorDni[c.dni] = r.rows[0].id;
    }

    // ── 3. Catálogo: producto + variante + unidades ──────────────────────
    let unidades = 0;
    for (const [idx, p] of datos.productos.entries()) {
      if (!p.precio_lista || p.precio_lista <= 0) {
        console.warn(`   ⚠ producto sin precio, omitido: ${p.nombre}`);
        continue;
      }
      const prod = await client.query(
        `INSERT INTO products (title, description) VALUES ($1, $2) RETURNING id`,
        [p.nombre, `Carga inicial ${marca}. Costo de referencia: $${p.costo ?? "-"}`],
      );
      const variante = await client.query(
        `INSERT INTO product_variants (product_id, current_price) VALUES ($1, $2) RETURNING id`,
        [prod.rows[0].id, p.precio_lista],
      );
      for (let n = 1; n <= p.stock; n++) {
        await client.query(
          `INSERT INTO product_units (variant_id, unit_code, notes) VALUES ($1, $2, $3)`,
          [variante.rows[0].id, `MIG-${String(idx + 1).padStart(2, "0")}-${String(n).padStart(3, "0")}`, marca],
        );
        unidades++;
      }
    }

    // ── 4. Créditos + cuotas ─────────────────────────────────────────────
    let cuotasInsertadas = 0;
    for (const cr of datos.creditos) {
      const customerId = customerIdPorDni[cr.cliente_dni];
      if (!customerId) throw new Error(`Crédito fila ${cr.fila_excel}: cliente DNI ${cr.cliente_dni} no encontrado.`);

      const totalAmount = cr.ctas * cr.imp;
      const notas = [
        marca,
        cr.tipo === "SALE" ? `Producto: ${cr.producto}` : null,
        `Fila Excel ${cr.fila_excel} — zona ${cr.zona}.`,
        `Histórico pre-sistema: pagado $${cr.pagado.toLocaleString("es-AR")}` +
          (cr.pagos_historicos != null ? ` en ${cr.pagos_historicos} pagos` : "") + ".",
      ].filter(Boolean).join(" ");
      const fechaInicio = cr.f_inicio ? new Date(`${cr.f_inicio}T12:00:00`) : hoy;

      const credito = await client.query(
        `INSERT INTO credits
           (customer_id, created_by, approved_by, type, total_amount,
            installments_count, payment_frequency, status, notes, approved_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8, $9, $9) RETURNING id`,
        [customerId, userIdPorZona[cr.zona] ?? null, adminId, cr.tipo, totalAmount,
         cr.ctas, cr.frecuencia, notas, fechaInicio],
      );

      const fechas = cronograma(cr, hoy);
      for (let n = 1; n <= cr.ctas; n++) {
        const pagada = n <= cr.cuotas_pagadas;
        const parcial = !pagada && n === cr.cuotas_pagadas + 1 && cr.resto_parcial > 0;
        await client.query(
          `INSERT INTO installments
             (credit_id, installment_number, due_date, payment_frequency,
              original_amount, amount_due, amount_paid, status, last_penalty_applied_at)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7, NOW())`,
          [credito.rows[0].id, n, fechas[n - 1], cr.frecuencia, cr.imp,
           pagada ? cr.imp : parcial ? cr.resto_parcial : 0,
           pagada ? "PAID" : parcial ? "PARTIAL" : "PENDING"],
        );
        cuotasInsertadas++;
      }
    }

    // ── 5. Verificación interna (dentro de la transacción) ───────────────
    const v = await client.query(
      `SELECT COUNT(DISTINCT c.id)::int AS creditos,
              COALESCE(SUM(i.amount_due - i.amount_paid), 0)::float8 AS saldo
       FROM credits c JOIN installments i ON i.credit_id = c.id
       WHERE c.notes LIKE $1`,
      [`%${marca}%`],
    );
    const saldoCargado = Math.round(v.rows[0].saldo * 100) / 100;
    const saldoEsperado = datos.meta.totales.suma_saldo;

    console.log("── Verificación ──");
    console.log(`   Usuarios     : ${datos.usuarios.length} (password temporal: ${PASSWORD_TEMPORAL})`);
    console.log(`   Clientes     : ${datos.clientes.length}`);
    console.log(`   Productos    : ${datos.productos.length} (+${unidades} unidades)`);
    console.log(`   Créditos     : ${v.rows[0].creditos} / esperados ${datos.creditos.length}`);
    console.log(`   Cuotas       : ${cuotasInsertadas}`);
    console.log(`   SALDO cargado: $${saldoCargado.toLocaleString("es-AR")} / Excel $${saldoEsperado.toLocaleString("es-AR")}`);

    if (v.rows[0].creditos !== datos.creditos.length) {
      throw new Error("Cantidad de créditos no coincide — rollback.");
    }
    if (Math.abs(saldoCargado - saldoEsperado) > 1) {
      throw new Error(`Saldo cargado difiere del Excel en $${(saldoCargado - saldoEsperado).toFixed(2)} — rollback.`);
    }

    if (EJECUTAR) {
      await client.query("COMMIT");
      console.log("\n✅ CARGA CONFIRMADA (COMMIT). Seguir con el checklist §9 del plan.\n");
    } else {
      await client.query("ROLLBACK");
      console.log("\n🧪 Dry-run OK: todo validó y se revirtió (ROLLBACK). Correr con --ejecutar para la carga real.\n");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`\n❌ ABORTADO (rollback): ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

// Solo ejecuta cuando se invoca directamente: generate.sql.js importa los
// helpers de cronograma (única fuente de fechas) sin disparar la carga.
if (require.main === module) {
  main();
}

module.exports = { cronograma, proximoDia, iso, PASSWORD_TEMPORAL };
