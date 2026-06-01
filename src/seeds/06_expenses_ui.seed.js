const pool = require('../config/db');

/**
 * Inserta gastos de muestra para validar visualmente la tabla de la pantalla de gastos.
 * La ejecución es idempotente: si detecta registros con la marca visual, no vuelve a insertar.
 */
const seed = async () => {
  const marker = 'SEED_UI_GASTOS_2026';
  const exists = await pool.query(
    `SELECT id FROM expenses WHERE description LIKE $1 LIMIT 1`,
    [`%${marker}%`]
  );

  if (exists.rows.length > 0) {
    console.log('   ⚠️   Semilla 06 ya ejecutada — gastos visuales existentes.');
    return;
  }

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

    const collectorRow = await client.query(
      `SELECT id, full_name FROM users WHERE role = 'COLLECTOR' LIMIT 1`
    );

    const actorIds = [
      adminId,
      collectorRow.rows[0]?.id || adminId,
      adminId,
      collectorRow.rows[0]?.id || adminId,
      adminId,
      adminId,
      collectorRow.rows[0]?.id || adminId,
      adminId,
    ];

    const categories = await client.query(
      `SELECT id, name FROM expense_categories WHERE active = TRUE`
    );
    const byName = new Map(categories.rows.map((c) => [c.name.toLowerCase(), c.id]));

    const rows = [
      { date: '2026-04-28', desc: `Alquiler mensual oficina (${marker})`, amount: 45000, method: 'TRANSFER', ref: 'TRF-2026-0847', category: 'alquiler' },
      { date: '2026-04-28', desc: `Servicio de internet y telefonia (${marker})`, amount: 8200, method: 'TRANSFER', ref: 'TRF-2026-0848', category: 'servicios' },
      { date: '2026-04-27', desc: `Papeleria e insumos de oficina (${marker})`, amount: 3500, method: 'CASH', ref: null, category: 'insumos' },
      { date: '2026-04-26', desc: `Servicio de limpieza mensual (${marker})`, amount: 12000, method: 'CASH', ref: null, category: 'sueldos externos' },
      { date: '2026-04-25', desc: `Reparacion impresora (${marker})`, amount: 6800, method: 'CASH', ref: null, category: 'otros' },
      { date: '2026-04-24', desc: `Compra cartuchos toner (${marker})`, amount: 2100, method: 'CASH', ref: null, category: 'insumos' },
      { date: '2026-04-23', desc: `Honorarios contador (${marker})`, amount: 9500, method: 'TRANSFER', ref: 'TRF-2026-0831', category: 'sueldos externos' },
      { date: '2026-04-22', desc: `Gastos varios - reunion clientes (${marker})`, amount: 1800, method: 'CASH', ref: null, category: 'otros' },
    ];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const categoryId = byName.get(r.category) || null;
      await client.query(
        `INSERT INTO expenses (amount, description, expense_date, register_date, payment_method, transfer_reference, category_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [r.amount, r.desc, r.date, r.date, r.method, r.ref, categoryId, actorIds[i]]
      );
    }

    await client.query('COMMIT');
    console.log('   ✅  Semilla 06: 8 gastos visuales insertados.');
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
    .then(() => { console.log('\n✅ Seed 06 completado.'); process.exit(0); })
    .catch((err) => { console.error('\n❌ Error:', err.message); process.exit(1); });
}
