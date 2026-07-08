// Semilla 05 — Datos específicos para tests E2E
// Crea: créditos PENDING_APPROVAL, cliente portal B2C, caja abierta.
//
// Requisito: ejecutar semillas 01, 02, 03 y 04 antes que esta.
//
// Ejecutar: node src/seeds/05_e2e.seed.js
// o agregar a index.seed.js y ejecutar npm run seed

const bcrypt = require('bcryptjs');
const pool = require('../config/db');

const TODAY = new Date('2026-04-28T12:00:00Z');
const dateStr = (d) => d.toISOString().split('T')[0];
const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
};
const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};
const cuota = (total, rate, count) =>
  Math.ceil((total * (1 + rate)) / count / 1000) * 1000;

const seed = async () => {
  const check = await pool.query(`SELECT id FROM customers WHERE dni = '40567890'`);
  if (check.rows.length > 0) {
    const clientPassword = await bcrypt.hash('1234', 10);
    await pool.query(
      `UPDATE customers
         SET portal_enabled = TRUE,
             portal_password_hash = $1,
             portal_is_temp_password = FALSE,
             portal_locked_at = NULL,
             portal_failed_attempts = 0
       WHERE dni = '40567890'`,
      [clientPassword],
    );
    console.log('   ⚠️   Semilla 05 ya ejecutada — saltando.');
    console.log('   ✅  Cliente portal (DNI 40567890) re-habilitado para login E2E.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Usuarios requeridos ────────────────────────────────────────────
    const adminRow = await client.query(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`);
    if (!adminRow.rows[0]) throw new Error('Admin no encontrado. Ejecutar semilla 01.');
    const adminId = adminRow.rows[0].id;

    const sellerRow = await client.query(`SELECT id FROM users WHERE role = 'SELLER' LIMIT 1`);
    const sellerId = sellerRow.rows[0].id;

    const collectorRow = await client.query(`SELECT id FROM users WHERE role = 'COLLECTOR' LIMIT 1`);
    const collectorId = collectorRow.rows[0].id;

    // ── 1. Cliente portal B2C (para 12-portal-clientes.cy.ts) ────────
    console.log('  Creando cliente portal B2C...');
    const clientPassword = await bcrypt.hash('1234', 10);

    const portalCustomer = await client.query(
      `INSERT INTO customers (full_name, dni, address, phone, email, assigned_collector_id, status, portal_password_hash, portal_is_temp_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      ['Pedro Luis Gómez', '40567890', 'Av.长春 456, CABA', '1156789012', 'pedrogomez@email.com', collectorId, 'ACTIVE', clientPassword, false]
    );
    await client.query(`UPDATE customers SET portal_enabled = TRUE WHERE id = $1`, [portalCustomer.rows[0].id]);
    const portalCustomerId = portalCustomer.rows[0].id;
    console.log('   ✅  Cliente portal B2C creado (DNI: 40567890, pass: 1234).');

    // ── 2. Productos y unidades para créditos PENDING ──────────────────────
    console.log('  Creando productos para créditos PENDING...');

    // Categorías específicas
    const catElec = await client.query(
      `SELECT id FROM product_categories WHERE LOWER(name) = 'electrónica' LIMIT 1`
    );
    const catIndum = await client.query(
      `SELECT id FROM product_categories WHERE LOWER(name) = 'indumentaria y calzado' LIMIT 1`
    );
    const catElecId  = catElec.rows[0]?.id  || (await client.query(`SELECT id FROM product_categories LIMIT 1`)).rows[0].id;
    const catIndumId = catIndum.rows[0]?.id || catElecId;

    // Marcas
    const sonyRow = await client.query(`SELECT id FROM product_brands WHERE LOWER(name) = 'sony' LIMIT 1`);
    const sonyId  = sonyRow.rows[0]?.id || null;

    const genericRow = await client.query(`SELECT id FROM product_brands WHERE LOWER(name) = 'genérico' LIMIT 1`);
    const genericId  = genericRow.rows[0]?.id || null;

    // Producto 1 — Consola PlayStation 5
    const product1 = await client.query(
      `INSERT INTO products (title, description, model, brand_id, category_id, status)
       VALUES ($1,$2,$3,$4,$5,'ACTIVE') RETURNING id`,
      [
        'Consola PlayStation 5',
        'Consola de videojuegos Sony con lector de discos, 825 GB SSD NVMe, GPU de 10.3 TFLOPS y control DualSense.',
        'CFI-1215A01X',
        sonyId,
        catElecId,
      ]
    );
    const product1Id = product1.rows[0].id;

    const variant1 = await client.query(
      `INSERT INTO product_variants (product_id, color, size, capacity, current_price, status)
       VALUES ($1,$2,$3,$4,650000,'ACTIVE') RETURNING id`,
      [product1Id, 'Blanco', null, '825 GB']
    );
    const variant1Id = variant1.rows[0].id;

    await client.query(
      `INSERT INTO product_units (variant_id, unit_code, status) VALUES ($1,'U99901','SOLD')`,
      [variant1Id]
    );

    for (const pr of [
      { freq: 'MONTHLY', count: 2, rate: 0.48 },
      { freq: 'MONTHLY', count: 3, rate: 0.80 },
      { freq: 'MONTHLY', count: 4, rate: 0.96 },
    ]) {
      await client.query(
        `INSERT INTO product_rates (product_id, payment_frequency, installments_count, rate, active)
         VALUES ($1,$2,$3,$4,TRUE)`,
        [product1Id, pr.freq, pr.count, pr.rate]
      );
    }

    // Producto 2 — Bicicleta Mountain Bike
    const product2 = await client.query(
      `INSERT INTO products (title, description, model, brand_id, category_id, status)
       VALUES ($1,$2,$3,$4,$5,'ACTIVE') RETURNING id`,
      [
        'Bicicleta Mountain Bike',
        'Bicicleta mountain bike rodado 29 con cuadro de aluminio, frenos de disco hidráulicos y 21 velocidades.',
        'MTB-ROD29-ALU',
        genericId,
        catIndumId,
      ]
    );
    const product2Id = product2.rows[0].id;

    const variant2 = await client.query(
      `INSERT INTO product_variants (product_id, color, size, capacity, current_price, status)
       VALUES ($1,$2,$3,$4,280000,'ACTIVE') RETURNING id`,
      [product2Id, 'Negro', 'Talle M', null]
    );
    const variant2Id = variant2.rows[0].id;

    await client.query(
      `INSERT INTO product_units (variant_id, unit_code, status) VALUES ($1,'U99902','SOLD')`,
      [variant2Id]
    );

    for (const pr of [
      { freq: 'MONTHLY', count: 2, rate: 0.48 },
      { freq: 'MONTHLY', count: 3, rate: 0.80 },
    ]) {
      await client.query(
        `INSERT INTO product_rates (product_id, payment_frequency, installments_count, rate, active)
         VALUES ($1,$2,$3,$4,TRUE)`,
        [product2Id, pr.freq, pr.count, pr.rate]
      );
    }

    console.log('   ✅  2 productos creados.');

    // ── 3. Créditos PENDING_APPROVAL (para 10-admin-aprobaciones.cy.ts) ─
    console.log('  Creando créditos PENDING_APPROVAL...');

    const unit1Row = await client.query(
      `SELECT id FROM product_units WHERE unit_code = 'U99901'`
    );
    const unit1Id = unit1Row.rows[0].id;

    // Crédito PENDING 1
    await client.query(
      `INSERT INTO credits
         (customer_id, created_by, type, total_amount, down_payment, installments_count,
          payment_frequency, interest_rate, status, approved_by, approved_at,
          created_at, updated_at)
       VALUES ($1,$2,'SALE',$3,0,$4,'MONTHLY',$5,'PENDING_APPROVAL',NULL,NULL,$6,$6)`,
      [portalCustomerId, sellerId, 650000, 3, 0.80, dateStr(TODAY)]
    );

    const pendingCredit1 = await client.query(
      `SELECT id FROM credits WHERE customer_id = $1 AND status = 'PENDING_APPROVAL' ORDER BY created_at DESC LIMIT 1`,
      [portalCustomerId]
    );
    const pendingCredit1Id = pendingCredit1.rows[0].id;

    await client.query(
      `INSERT INTO credit_products (credit_id, product_unit_id, historical_price, historical_rate)
       VALUES ($1,$2,$3,$4)`,
      [pendingCredit1Id, unit1Id, 650000, 0.80]
    );

    // Crédito PENDING 2
    const otherCustomers = await client.query(
      `SELECT id FROM customers WHERE status = 'ACTIVE' AND assigned_collector_id IS NOT NULL LIMIT 1`
    );
    const otherCustomerId = otherCustomers.rows[0].id;

    const unit2Row = await client.query(
      `SELECT id FROM product_units WHERE unit_code = 'U99902'`
    );
    const unit2Id = unit2Row.rows[0].id;

    await client.query(
      `INSERT INTO credits
         (customer_id, created_by, type, total_amount, down_payment, installments_count,
          payment_frequency, interest_rate, status, approved_by, approved_at,
          created_at, updated_at)
       VALUES ($1,$2,'SALE',$3,0,$4,'MONTHLY',$5,'PENDING_APPROVAL',NULL,NULL,$6,$6)`,
      [otherCustomerId, sellerId, 280000, 2, 0.48, dateStr(addDays(TODAY, -1))]
    );

    const pendingCredit2 = await client.query(
      `SELECT id FROM credits WHERE customer_id = $1 AND status = 'PENDING_APPROVAL' ORDER BY created_at DESC LIMIT 1`,
      [otherCustomerId]
    );
    const pendingCredit2Id = pendingCredit2.rows[0].id;

    await client.query(
      `INSERT INTO credit_products (credit_id, product_unit_id, historical_price, historical_rate)
       VALUES ($1,$2,$3,$4)`,
      [pendingCredit2Id, unit2Id, 280000, 0.48]
    );

    // Crédito PENDING 3 (LOAN)
    const anotherCustomer = await client.query(
      `SELECT id FROM customers WHERE status = 'ACTIVE' AND id != $1 AND assigned_collector_id IS NOT NULL LIMIT 1`,
      [portalCustomerId]
    );
    const anotherCustomerId = anotherCustomer.rows[0].id;

    await client.query(
      `INSERT INTO credits
         (customer_id, created_by, type, total_amount, down_payment, installments_count,
          payment_frequency, interest_rate, status, approved_by, approved_at,
          created_at, updated_at)
       VALUES ($1,$2,'LOAN',$3,0,$4,'MONTHLY',$5,'PENDING_APPROVAL',NULL,NULL,$6,$6)`,
      [anotherCustomerId, sellerId, 150000, 3, 0.85, dateStr(addDays(TODAY, -2))]
    );

    console.log('   ✅  3 créditos PENDING_APPROVAL creados.');

    // ── 4. Créditos ACTIVEs para portal cliente (12) ─────────────────────
    console.log('  Creando créditos ACTIVEs para portal cliente...');

    const amt1 = cuota(650000, 0.80, 3);
    await client.query(
      `UPDATE credits SET status = 'ACTIVE', approved_by = $1, approved_at = $2 WHERE id = $3`,
      [adminId, dateStr(addDays(TODAY, -10)), pendingCredit1Id]
    );

    for (let i = 0; i < 3; i++) {
      const dueDate = addMonths(addDays(TODAY, -10), i + 1);
      const isPast = dueDate < TODAY;
      const status = isPast ? 'PAID' : 'PENDING';
      const paid = isPast ? amt1 : 0;

      await client.query(
        `INSERT INTO installments
           (credit_id, installment_number, due_date, amount_due, original_amount,
            amount_paid, status, payment_frequency, created_at)
         VALUES ($1,$2,$3,$4,$4,$5,$6,'MONTHLY',$7)`,
        [pendingCredit1Id, i + 1, dateStr(dueDate), amt1, paid, status, dateStr(addDays(TODAY, -10))]
      );

      if (isPast) {
        const payDate = addDays(dueDate, -2);
        await client.query(
          `INSERT INTO payments
             (installment_id, collector_id, amount_received, amount_cash, amount_transfer, payment_method,
              status, approved_by, approved_at, created_at)
           VALUES (CURRVAL(),$1,$2,$2,0,'CASH','APPROVED',$3,$4,$4)`,
          [collectorId, amt1, adminId, payDate]
        );
      }
    }

    console.log('   ✅  Créditos ACTIVEs para portal cliente creados.');

// ── 5. Caja abierta (para 11-caja-tesoreria.cy.ts) ──────────────────
    // La caja ABIERTA se representa como que NO existe un cierre para el día de hoy.
    // El servicio de caja verifica si hay cierre hoy para determinar si está abierta.
    console.log('  Verificando caja del día...');

    const boxDate = dateStr(TODAY);
    const boxExists = await client.query(
      `SELECT id FROM cash_registers WHERE register_date = $1`,
      [boxDate]
    );

    if (boxExists.rows.length === 0) {
      console.log('   ✅  Caja del día NO还存在 → ABIERTA (sin cierre)');
    } else {
      console.log('   ⚠️  Caja del día ya está CERRADA.');
    }

    // ── 6. Gastos tipo para testing ─────────────────────────────────────
    console.log('  Verificando categoría de gasto...');

    const expenseCategory = await client.query(
      `INSERT INTO expense_categories (name, active)
       VALUES ($1,TRUE) ON CONFLICT (name) DO NOTHING RETURNING id`,
      ['Insumos']
    );

    if (!expenseCategory.rows[0]) {
      console.log('   ⚠️  Categoría Insumos ya existe.');
    } else {
      console.log('   ✅  Categoría de gasto Insumos verificada.');
    }

    await client.query('COMMIT');

    console.log('');
    console.log('   ┌──────────────────────────────────────────────┐');
    console.log('   │  Semilla 05 — Datos E2E Tests              │');
    console.log('   ├──────────────────────────────────────────────┤');
    console.log('   │  Portal Cliente:                          │');
    console.log('   │    DNI: 40567890                          │');
    console.log('   │    Pass: 1234                             │');
    console.log('   ├──────────────────────────────────────────────┤');
    console.log('   │  Créditos PENDING_APPROVAL: 3           │');
    console.log('   │  Créditos ACTIVEs portal: 1              │');
    console.log('   │  Caja: ABIERTA (hoy)                      │');
    console.log('   └──────────────────────────────────────────────┘');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = seed;

// Ejecutar directamente si se llama desde línea de comandos
if (require.main === module) {
  seed()
    .then(() => { console.log('\n✅ Seed 05 completado.'); process.exit(0); })
    .catch((err) => { console.error('\n❌ Error:', err.message); process.exit(1); });
}
