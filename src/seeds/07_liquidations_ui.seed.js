// Semilla 07 — Datos de liquidaciones para replicar pantalla UI
// Crea sueldos fijos, comisiones pendientes y liquidaciones históricas.

const pool = require('../config/db');

const seed = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const adminRow = await client.query(
      `SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' ORDER BY created_at ASC LIMIT 1`
    );
    if (!adminRow.rows[0]) throw new Error('Admin no encontrado. Ejecutar semilla 01 primero.');
    const adminId = adminRow.rows[0].id;

    const usersRes = await client.query(
      `SELECT id, role
       FROM users
       WHERE role IN ('SELLER','COLLECTOR','SELLER_COLLECTOR') AND status = 'ACTIVE'
       ORDER BY created_at ASC`
    );
    if (!usersRes.rows.length) throw new Error('No hay usuarios operativos activos. Ejecutar semilla 04 primero.');

    const userByRole = {
      SELLER: usersRes.rows.find(u => u.role === 'SELLER'),
      COLLECTOR: usersRes.rows.find(u => u.role === 'COLLECTOR'),
      SELLER_COLLECTOR: usersRes.rows.find(u => u.role === 'SELLER_COLLECTOR'),
    };

    for (const [role, amount] of [
      ['COLLECTOR', 15000],
      ['SELLER_COLLECTOR', 8000],
    ]) {
      const user = userByRole[role];
      if (!user) continue;
      const salaryRow = await client.query(
        `SELECT id FROM salaries WHERE user_id = $1 LIMIT 1`,
        [user.id]
      );
      if (salaryRow.rows[0]) {
        await client.query(
          `UPDATE salaries
           SET weekly_amount = $1,
               active = TRUE,
               updated_at = NOW()
           WHERE id = $2`,
          [amount, salaryRow.rows[0].id]
        );
        continue;
      }
      await client.query(
        `INSERT INTO salaries (user_id, weekly_amount, active)
         VALUES ($1, $2, TRUE)`,
        [user.id, amount]
      );
    }

    const sellerCreditsRes = await client.query(
      `SELECT id, created_by
       FROM credits
       WHERE type = 'SALE'
         AND created_by IN ($1::uuid, $2::uuid)
       ORDER BY approved_at DESC NULLS LAST, created_at DESC
       LIMIT 24`,
      [
        userByRole.SELLER ? userByRole.SELLER.id : null,
        userByRole.SELLER_COLLECTOR ? userByRole.SELLER_COLLECTOR.id : null,
      ]
    );

    const pendingWindows = [
      ['2026-05-19', '2026-05-25', 12400],
      ['2026-05-19', '2026-05-25', 8900],
      ['2026-05-12', '2026-05-18', 6100],
      ['2026-05-12', '2026-05-18', 3200],
      ['2026-05-05', '2026-05-11', 1800],
    ];

    let pendingInserted = 0;
    for (let i = 0; i < pendingWindows.length && i < sellerCreditsRes.rows.length; i++) {
      const credit = sellerCreditsRes.rows[i];
      const [weekStart, weekEnd, amount] = pendingWindows[i];
      await client.query(
        `INSERT INTO commissions (user_id, credit_id, amount, status, week_start, week_end, created_at)
         SELECT $1, $2, $3, 'PENDING', $4::date, $5::date, ($5::date + time '10:00')
         WHERE NOT EXISTS (
           SELECT 1
           FROM commissions
           WHERE user_id = $1
             AND credit_id = $2
             AND status = 'PENDING'
             AND week_start = $4::date
         )`,
        [credit.created_by, credit.id, amount, weekStart, weekEnd]
      );
      pendingInserted++;
    }

    const paidWindows = [
      ['2026-04-21', '2026-04-27', 11200, 0, 'TRANSFER', 'SEED-LIQ-001'],
      ['2026-04-14', '2026-04-20', 9400, 0, 'CASH', null],
      ['2026-04-07', '2026-04-13', 7600, 0, 'CASH', null],
      ['2026-03-31', '2026-04-06', 6200, 0, 'TRANSFER', 'SEED-LIQ-002'],
      ['2026-04-21', '2026-04-27', 2800, 15000, 'CASH', null],
      ['2026-04-14', '2026-04-20', 3100, 15000, 'CASH', null],
      ['2026-04-07', '2026-04-13', 2100, 15000, 'CASH', null],
      ['2026-03-31', '2026-04-06', 2600, 15000, 'TRANSFER', 'SEED-LIQ-003'],
      ['2026-04-21', '2026-04-27', 5700, 8000, 'TRANSFER', 'SEED-LIQ-004'],
      ['2026-04-14', '2026-04-20', 6200, 8000, 'CASH', null],
    ];

    for (let i = 0; i < paidWindows.length && (i + 5) < sellerCreditsRes.rows.length; i++) {
      const credit = sellerCreditsRes.rows[i + 5];
      const [weekStart, weekEnd, commissionAmount, salaryAmount, paymentMethod, transferRef] = paidWindows[i];

      await client.query(
        `INSERT INTO commissions (user_id, credit_id, amount, status, week_start, week_end, created_at)
         SELECT $1, $2, $3, 'PAID', $4::date, $5::date, ($5::date + time '10:00')
         WHERE NOT EXISTS (
           SELECT 1
           FROM commissions
           WHERE user_id = $1
             AND credit_id = $2
             AND status = 'PAID'
             AND week_start = $4::date
         )`,
        [credit.created_by, credit.id, commissionAmount, weekStart, weekEnd]
      );

      await client.query(
        `INSERT INTO commission_liquidations
           (user_id, paid_by, week_start, week_end, commissions_total, salary_amount,
            total_paid, payment_method, transfer_reference, paid_at)
         VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, ($4::date + time '12:00'))
         ON CONFLICT (user_id, week_start) DO NOTHING`,
        [
          credit.created_by,
          adminId,
          weekStart,
          weekEnd,
          commissionAmount,
          salaryAmount,
          commissionAmount + salaryAmount,
          paymentMethod,
          transferRef,
        ]
      );
    }

    await client.query('COMMIT');
    console.log(`   ✅  Seed 07 aplicado. Comisiones pendientes objetivo: ${pendingInserted}.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = seed;
