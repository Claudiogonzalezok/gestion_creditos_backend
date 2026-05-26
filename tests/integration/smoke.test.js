// Smoke test: verifica que la infra de integration funciona end-to-end.
//   · Conexión al Postgres de test OK
//   · Schema aplicado (tablas críticas existen)
//   · Fixtures funcionan e insertan datos
//   · Truncate entre tests aísla estado
//   · Helpers de dates devuelven formato correcto
//
// Si este test pasa, todo el resto del stack está listo para escribir
// tests financieros de verdad.

const { pool, setupTestSuite } = require('./helpers/db');
const { createInstallmentFixture, reloadInstallment } = require('./helpers/fixtures');
const { today, daysAgo, daysFromNow } = require('./helpers/dates');

setupTestSuite();

describe('Smoke — infra integration', () => {
  it('conecta al Postgres de test', async () => {
    const r = await pool.query('SELECT 1 AS ok');
    expect(r.rows[0].ok).toBe(1);
  });

  it('aplicó las migraciones (tablas críticas presentes)', async () => {
    const r = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('installments','payments','credits','customers','cron_execution_log')
       ORDER BY table_name`
    );
    expect(r.rows.map((row) => row.table_name)).toEqual([
      'credits', 'cron_execution_log', 'customers', 'installments', 'payments',
    ]);
  });

  it('seedeó system_config con las claves financieras', async () => {
    const r = await pool.query(
      `SELECT key FROM system_config
       WHERE key IN ('penalty_grace_days','penalty_rate_daily','penalty_max_rate')
       ORDER BY key`
    );
    expect(r.rows.map((row) => row.key)).toEqual([
      'penalty_grace_days', 'penalty_max_rate', 'penalty_rate_daily',
    ]);
  });

  it('crea una cuota con la invariante amount_due = original + penalty', async () => {
    const inst = await createInstallmentFixture({
      original_amount: 1500,
      penalty_amount:  100,
    });
    expect(inst.original_amount).toBe(1500);
    expect(inst.penalty_amount).toBe(100);
    expect(inst.amount_due).toBe(1600);
  });

  it('truncate aísla estado entre tests (primer test ya insertó arriba; este no debe verlo)', async () => {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM installments');
    expect(r.rows[0].n).toBe(0);
  });

  it('reloadInstallment trae la fila actualizada', async () => {
    const inst = await createInstallmentFixture({ original_amount: 800 });
    await pool.query(`UPDATE installments SET amount_paid = 200 WHERE id = $1`, [inst.id]);
    const reloaded = await reloadInstallment(inst.id);
    expect(reloaded.amount_paid).toBe(200);
  });

  it('helpers de dates devuelven formato YYYY-MM-DD', () => {
    const tody = today();
    const yest = daysAgo(1);
    const morrow = daysFromNow(1);
    expect(tody).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(yest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(morrow).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(yest).getTime()).toBeLessThan(new Date(tody).getTime());
    expect(new Date(morrow).getTime()).toBeGreaterThan(new Date(tody).getTime());
  });
});
