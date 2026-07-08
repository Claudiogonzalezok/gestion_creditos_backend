// Semilla 08 — Planilla de cobro para hoy (test CO-04)
// Genera una collection_sheet activa para el COLLECTOR del día de hoy
// usando cuotas PENDING ya existentes en la BD.
//
// Si no hay cuotas PENDING para el collector, crea un cliente simple
// con un crédito ACTIVE y cuotas vencidas para hoy.
//
// Requisito: semillas 01–04 ejecutadas antes.
// Ejecutar: node src/seeds/08_collector_sheet.seed.js

require('dotenv').config();
const pool = require('../config/db');

const TODAY_STR = new Date().toISOString().split('T')[0]; // fecha real del sistema

const seed = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Admin y Collector ─────────────────────────────────────────────────
    const adminRow = await client.query(
      `SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`
    );
    if (!adminRow.rows[0]) throw new Error('Admin no encontrado. Ejecutar semilla 01.');
    const adminId = adminRow.rows[0].id;

    const collectorRow = await client.query(
      `SELECT id, full_name FROM users WHERE role = 'COLLECTOR' AND status = 'ACTIVE' LIMIT 1`
    );
    if (!collectorRow.rows[0]) throw new Error('Collector no encontrado. Ejecutar semilla 04.');
    const collectorId = collectorRow.rows[0].id;
    const collectorName = collectorRow.rows[0].full_name;

    // ── Verificar planilla existente para hoy ─────────────────────────────
    const existingSheet = await client.query(
      `SELECT id FROM collection_sheets
       WHERE collector_id = $1 AND sheet_date::date = $2::date AND status = 'ACTIVE'`,
      [collectorId, TODAY_STR]
    );
    if (existingSheet.rows.length > 0) {
      console.log(`   ⚠️   Ya existe planilla para ${collectorName} hoy (${TODAY_STR}). Saltando.`);
      await client.query('ROLLBACK');
      return;
    }

    // ── Buscar cuotas PENDING del collector ───────────────────────────────
    const pendingInstallments = await client.query(
      `SELECT i.id, i.amount_due, i.due_date
       FROM installments i
       JOIN credits c      ON c.id  = i.credit_id
       JOIN customers cu   ON cu.id = c.customer_id
       WHERE cu.assigned_collector_id = $1
         AND i.status IN ('PENDING', 'OVERDUE')
         AND c.status = 'ACTIVE'
       ORDER BY i.due_date ASC
       LIMIT 5`,
      [collectorId]
    );

    let installments = pendingInstallments.rows;

    // ── Si no hay cuotas: crear cliente + crédito + cuotas para hoy ───────
    if (installments.length === 0) {
      console.log('  No hay cuotas pendientes para el collector — creando datos de prueba...');

      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash('123456', 10);

      // Cliente de prueba
      const custRes = await client.query(
        `INSERT INTO customers (full_name, dni, address, phone, email, assigned_collector_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE') RETURNING id`,
        ['Test Cliente CO04', '99999999', 'Calle Test 123', '1100000000', 'co04@test.com', collectorId]
      );
      const customerId = custRes.rows[0].id;

      // Crédito LOAN aprobado (no requiere producto)
      const creditRes = await client.query(
        `INSERT INTO credits
           (customer_id, created_by, type, total_amount, down_payment,
            installments_count, payment_frequency, interest_rate,
            status, approved_by, approved_at)
         VALUES ($1,$2,'LOAN',300000,0,3,'MONTHLY',0.15,'ACTIVE',$3,NOW())
         RETURNING id`,
        [customerId, adminId, adminId]
      );
      const creditId = creditRes.rows[0].id;

      // 3 cuotas: hoy, +1 mes, +2 meses
      const instIds = [];
      for (let i = 0; i < 3; i++) {
        const due = new Date();
        due.setMonth(due.getMonth() + i);
        const dueStr = due.toISOString().split('T')[0];
        const status = i === 0 ? 'PENDING' : 'PENDING';

        const instRes = await client.query(
          `INSERT INTO installments
             (credit_id, installment_number, amount_due, original_amount, due_date, status)
           VALUES ($1,$2,115000,115000,$3,$4) RETURNING id, amount_due`,
          [creditId, i + 1, dueStr, status]
        );
        instIds.push(instRes.rows[0]);
      }
      installments = instIds.map(r => ({ id: r.id, amount_due: r.amount_due }));
      console.log('   ✅  Cliente + crédito LOAN + 3 cuotas creados.');
    }

    // ── Crear collection_sheet para hoy ──────────────────────────────────
    const sheetRes = await client.query(
      `INSERT INTO collection_sheets (collector_id, sheet_date, filter_used, generated_by)
       VALUES ($1, $2, 'ALL_PENDING', $3)
       RETURNING id`,
      [collectorId, TODAY_STR, adminId]
    );
    const sheetId = sheetRes.rows[0].id;

    // ── Insertar collection_sheet_details ─────────────────────────────────
    for (let idx = 0; idx < installments.length; idx++) {
      const inst = installments[idx];
      await client.query(
        `INSERT INTO collection_sheet_details
           (sheet_id, installment_id, order_number, planned_amount,
            inclusion_criteria, op_priority, remaining_amount_snapshot)
         VALUES ($1, $2, $3, $4, 'DUE_TODAY', 1, $4)`,
        [sheetId, inst.id, idx + 1, inst.amount_due]
      );
    }

    await client.query('COMMIT');
    console.log(`   ✅  Planilla generada para ${collectorName} (${TODAY_STR}) con ${installments.length} cuota(s).`);
    console.log(`       Sheet ID: ${sheetId}`);
    console.log(`       Iniciar sesión como COLLECTOR (DNI: 22222222 / pass: 123456) → Mi Ruta.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

seed().catch(err => {
  console.error('❌  Error en semilla 08:', err.message);
  process.exit(1);
});
