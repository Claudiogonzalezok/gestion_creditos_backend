require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

const TODAY_STR = new Date().toISOString().split('T')[0];

/**
 * Devuelve una fecha ISO (YYYY-MM-DD) desplazada N días desde hoy.
 * @param {number} daysOffset Días a sumar/restar respecto de hoy.
 * @returns {string}
 */
const isoFromToday = (daysOffset) => {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d.toISOString().split('T')[0];
};

/**
 * Crea una planilla de prueba para ADMIN con cuotas en todos los estados
 * visuales (PENDING, OVERDUE, PARTIAL, PAID) para validar pintado de filas.
 */
const seed = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const adminRow = await client.query(
      `SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`
    );
    if (!adminRow.rows[0]) {
      throw new Error('Admin no encontrado. Ejecutar semilla 01 primero.');
    }
    const adminId = adminRow.rows[0].id;

    const hash = await bcrypt.hash('123456', 10);

    const collectorDni = '24444444';
    const collectorEmail = 'cobrador.estados.ui@sistema.com';

    const collectorUpsert = await client.query(
      `INSERT INTO users (full_name, dni, email, address, password_hash, role, status, is_temp_password)
       VALUES ($1,$2,$3,$4,$5,'COLLECTOR','ACTIVE',FALSE)
       ON CONFLICT (dni)
       DO UPDATE SET
         full_name = EXCLUDED.full_name,
         email = EXCLUDED.email,
         address = EXCLUDED.address,
         password_hash = EXCLUDED.password_hash,
         status = 'ACTIVE'
       RETURNING id, full_name`,
      [
        'Cobrador Estados UI',
        collectorDni,
        collectorEmail,
        'Av. de Prueba 1000, CABA',
        hash,
      ]
    );

    const collectorId = collectorUpsert.rows[0].id;
    const collectorName = collectorUpsert.rows[0].full_name;

    // PAID se incluye solo para demo inicial. Al regenerar, por regla de negocio,
    // findInstallmentsForSheet NO vuelve a incluir cuotas totalmente pagadas.
    const statusesPlan = ['PENDING', 'OVERDUE', 'PARTIAL', 'PAID'];
    const dueDateByStatus = {
      PENDING: isoFromToday(8),
      OVERDUE: isoFromToday(-8),
      PARTIAL: isoFromToday(3),
      PAID: isoFromToday(-4),
    };
    const installmentIds = [];

    // Normaliza datos previos del collector de demo para que no contaminen
    // regeneraciones posteriores (si había cuotas viejas que quedaron OVERDUE).
    await client.query(
      `UPDATE installments i
       SET status = 'PAID', amount_paid = i.amount_due
       FROM credits c
       JOIN customers cu ON cu.id = c.customer_id
       WHERE i.credit_id = c.id
         AND cu.assigned_collector_id = $1
         AND cu.dni LIKE '8444444%'
         AND i.status IN ('PENDING', 'OVERDUE', 'PARTIAL')`,
      [collectorId]
    );

    for (let i = 0; i < statusesPlan.length; i++) {
      const idx = i + 1;
      const customerDni = `8444444${idx}`;
      const customerRes = await client.query(
        `INSERT INTO customers (full_name, dni, address, phone, email, assigned_collector_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE')
         ON CONFLICT (dni)
         DO UPDATE SET
           full_name = EXCLUDED.full_name,
           address = EXCLUDED.address,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           assigned_collector_id = EXCLUDED.assigned_collector_id,
           status = 'ACTIVE'
         RETURNING id`,
        [
          `Cliente Estado ${idx}`,
          customerDni,
          `Calle Estado ${idx} 123, Lanus`,
          `11370000${idx}`,
          `cliente.estado.${idx}@seed.local`,
          collectorId,
        ]
      );
      const customerId = customerRes.rows[0].id;

      const creditRes = await client.query(
        `INSERT INTO credits
           (customer_id, created_by, type, total_amount, down_payment,
            installments_count, payment_frequency, interest_rate,
            status, approved_by, approved_at)
         VALUES ($1,$2,'LOAN',$3,0,4,'MONTHLY',0.15,'ACTIVE',$2,NOW())
         RETURNING id`,
        [customerId, adminId, 180000 + idx * 10000]
      );
      const creditId = creditRes.rows[0].id;

      const amountDue = 42000 + idx * 5000;
      const status = statusesPlan[i];
      const dueDateStr = dueDateByStatus[status];
      const amountPaid = status === 'PAID' ? amountDue : status === 'PARTIAL' ? Math.round(amountDue * 0.45) : 0;

      const instRes = await client.query(
        `INSERT INTO installments
           (credit_id, installment_number, due_date, amount_due, original_amount,
            amount_paid, status, payment_frequency, created_at)
         VALUES ($1,1,$2,$3,$3,$4,$5,'MONTHLY',NOW())
         RETURNING id`,
        [creditId, dueDateStr, amountDue, amountPaid, status]
      );

      installmentIds.push(instRes.rows[0].id);
    }

    const existingSheet = await client.query(
      `SELECT id
       FROM collection_sheets
       WHERE collector_id = $1 AND sheet_date::date = $2::date AND status = 'ACTIVE'`,
      [collectorId, TODAY_STR]
    );

    if (existingSheet.rows[0]) {
      await client.query(
        `UPDATE collection_sheets
         SET status = 'REGENERATED'
         WHERE id = $1`,
        [existingSheet.rows[0].id]
      );
    }

    const sheetRes = await client.query(
      `INSERT INTO collection_sheets (collector_id, sheet_date, filter_used, generated_by)
       VALUES ($1, $2, 'ALL_PENDING', $3)
       RETURNING id`,
      [collectorId, TODAY_STR, adminId]
    );
    const sheetId = sheetRes.rows[0].id;

    for (let i = 0; i < installmentIds.length; i++) {
      const amount = 42000 + (i + 1) * 5000;
      await client.query(
        `INSERT INTO collection_sheet_details
           (sheet_id, installment_id, order_number, planned_amount,
            inclusion_criteria, op_priority, remaining_amount_snapshot)
         VALUES ($1, $2, $3, $4, 'DUE_TODAY', 1, $4)`,
        [sheetId, installmentIds[i], i + 1, amount]
      );
    }

    await client.query('COMMIT');
    console.log(`   OK semilla 10: planilla admin UI creada para ${collectorName} (${TODAY_STR}).`);
    console.log('      Estado esperado tras regenerar: mezcla de OVERDUE + PENDING + PARTIAL (PAID queda fuera por regla).');
    console.log(`      Credenciales collector: DNI ${collectorDni} / pass 123456`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = seed;

if (require.main === module) {
  seed()
    .then(() => {
      console.log('\nOK Seed 10 completado.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\nError:', err.message);
      process.exit(1);
    });
}
