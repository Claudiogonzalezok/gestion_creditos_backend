require('dotenv').config();
const pool = require('../config/db');

/**
 * Inserta cobros de muestra para que la pantalla de cobrador muestre
 * "Cobros recientes" con datos realistas.
 * La ejecución es idempotente usando marcadores en `notes`.
 */
const seed = async () => {
  const markerBase = 'SEED_UI_COBROS_2026';
  const markerExtra = 'SEED_UI_COBROS_2026_EXTRA';
  const baseExists = await pool.query(
    `SELECT id FROM payments WHERE notes LIKE $1 LIMIT 1`,
    [`%${markerBase}%`]
  );
  const extraExists = await pool.query(
    `SELECT id FROM payments WHERE notes LIKE $1 LIMIT 1`,
    [`%${markerExtra}%`]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const collectorRow = await client.query(
      `SELECT id, full_name
       FROM users
       WHERE role = 'COLLECTOR' AND status = 'ACTIVE'
       ORDER BY created_at ASC
       LIMIT 1`
    );

    if (!collectorRow.rows[0]) {
      throw new Error('Collector no encontrado. Ejecutar semilla 04 primero.');
    }

    const collectorId = collectorRow.rows[0].id;
    const collectorName = collectorRow.rows[0].full_name;

    const adminRow = await client.query(
      `SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`
    );
    const adminId = adminRow.rows[0]?.id || null;

    const sheetInstallments = await client.query(
      `SELECT i.id, i.amount_due
       FROM collection_sheets cs
       JOIN collection_sheet_details csd ON csd.sheet_id = cs.id
       JOIN installments i ON i.id = csd.installment_id
       WHERE cs.collector_id = $1
         AND cs.status = 'ACTIVE'
       ORDER BY cs.created_at DESC, csd.order_number ASC
       LIMIT 5`,
      [collectorId]
    );

    let installments = sheetInstallments.rows;

    if (installments.length === 0) {
      const fallbackInstallments = await client.query(
        `SELECT i.id, i.amount_due
         FROM installments i
         JOIN credits c ON c.id = i.credit_id
         JOIN customers cu ON cu.id = c.customer_id
         WHERE cu.assigned_collector_id = $1
           AND c.status = 'ACTIVE'
           AND i.status IN ('PENDING', 'OVERDUE', 'PARTIAL')
         ORDER BY i.due_date ASC
         LIMIT 5`,
        [collectorId]
      );
      installments = fallbackInstallments.rows;
    }

    if (installments.length === 0) {
      console.log('   ⚠️   Semilla 09: no hay cuotas aptas para generar cobros visuales.');
      await client.query('ROLLBACK');
      return;
    }

    let insertedBase = 0;
    if (baseExists.rows.length === 0) {
      for (let idx = 0; idx < installments.length; idx++) {
        const inst = installments[idx];
        const isTransfer = idx % 2 === 1;
        const paymentMethod = isTransfer ? 'TRANSFER' : 'CASH';
        const transferRef = isTransfer ? `TRF-SEED-09-${idx + 1}` : null;
        const notes = `Cobro visual ${idx + 1} (${markerBase})`;

        await client.query(
          `INSERT INTO payments
             (installment_id, collector_id, amount_received, amount_cash, amount_transfer, payment_method,
              transfer_reference, status, notes, created_at)
           VALUES ($1, $2, $3,
                   CASE WHEN $4 = 'CASH'     THEN $3::numeric ELSE 0 END,
                   CASE WHEN $4 = 'TRANSFER' THEN $3::numeric ELSE 0 END,
                   $4, $5, 'PENDING', $6, NOW() - ($7::text || ' hours')::interval)`,
          [inst.id, collectorId, inst.amount_due, paymentMethod, transferRef, notes, idx + 1]
        );
        insertedBase++;
      }
    }

    let insertedExtra = 0;
    if (extraExists.rows.length === 0) {
      const extraStatusPlan = ['APPROVED', 'REJECTED', 'PENDING', 'PENDING', 'PENDING'];

      for (let idx = 0; idx < 5; idx++) {
        const inst = installments[idx % installments.length];
        const status = extraStatusPlan[idx];
        const isTransfer = idx % 2 === 0;
        const paymentMethod = isTransfer ? 'TRANSFER' : 'CASH';
        const transferRef = isTransfer ? `TRF-SEED-09-X-${idx + 1}` : null;
        const notes = `Cobro visual extra ${idx + 1} (${markerExtra})`;
        const rejectionReason = status === 'REJECTED' ? 'No coincide comprobante (seed UI)' : null;
        const approvedAtHours = idx + 6;
        const approvedAtExpr =
          status === 'APPROVED' || status === 'REJECTED'
            ? `NOW() - (${approvedAtHours}::text || ' hours')::interval`
            : 'NULL';

        await client.query(
          `INSERT INTO payments
             (installment_id, collector_id, amount_received, amount_cash, amount_transfer, payment_method,
               transfer_reference, status, notes, rejection_reason,
               approved_by, approved_at, created_at)
            VALUES ($1, $2, $3,
                    CASE WHEN $4 = 'CASH'     THEN $3::numeric ELSE 0 END,
                    CASE WHEN $4 = 'TRANSFER' THEN $3::numeric ELSE 0 END,
                    $4, $5, $6, $7, $8,
                    $9, ${approvedAtExpr},
                    NOW() - ($10::text || ' hours')::interval)`,
          [
            inst.id,
            collectorId,
            inst.amount_due,
            paymentMethod,
            transferRef,
            status,
            notes,
            rejectionReason,
            status === 'APPROVED' || status === 'REJECTED' ? adminId : null,
            idx + 6,
          ]
        );
        insertedExtra++;
      }
    }

    await client.query('COMMIT');
    if (insertedBase === 0 && insertedExtra === 0) {
      console.log('   ⚠️   Semilla 09 ya estaba al día — no se insertaron cobros nuevos.');
      return;
    }
    console.log(
      `   ✅  Semilla 09: ${insertedBase} base + ${insertedExtra} extra insertado(s) para ${collectorName}.`
    );
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
    .then(() => { console.log('\n✅ Seed 09 completado.'); process.exit(0); })
    .catch((err) => { console.error('\n❌ Error:', err.message); process.exit(1); });
}
